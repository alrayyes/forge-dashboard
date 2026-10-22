package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/alrayyes/forge-dashboard/internal/singleuser"
)

// ErrSeveralUsers is returned when the database holds several users and the
// single-user cleanup has not settled them. Dropping the user id would merge
// their sessions, tokens and passkey labels, so the migration refuses. The
// settings migration refuses the same database first and says what to do.
var ErrSeveralUsers = errors.New("auth: the database has several users and the single-user cleanup has not run")

// ErrNoOwner is returned when sessions, API tokens or passkey labels exist but
// there is no user to attach them to. Copying nothing and dropping the old
// tables would lose them.
var ErrNoOwner = errors.New("auth: sessions, tokens or passkey labels exist but no user owns them")

// ErrOrphanRows is returned when a table holds rows keyed to a user id that is
// not in users and the single-user cleanup never ran on this database. The
// settings step refuses the same case. A database the cleanup did run on (it
// leaves a marker) drops them with a warning instead, since the cleanup always
// removed such leftovers without a word.
var ErrOrphanRows = errors.New("auth: rows belong to a user that does not exist")

// ErrCopyIncomplete is returned when a table's rows did not all reach its new
// shape. The step rolls back, so the old table is still there.
var ErrCopyIncomplete = errors.New("auth: rows were lost in the copy")

// MigrationSteps are the schema steps for the auth tables, in order. They run
// after the settings steps, and before any store creates its tables.
func MigrationSteps(log *slog.Logger) []dbmigrate.Step {
	tables := make([]string, 0, len(authRebuilds))
	for _, r := range authRebuilds {
		tables = append(tables, r.table)
	}

	return []dbmigrate.Step{{
		Name:      "drop the user id from sessions, API tokens, passkey labels and the request log",
		Tables:    tables,
		Preflight: preflightDropUserID,
		Run:       func(ctx context.Context, tx dbmigrate.Tx) error { return dropAuthUserID(ctx, tx, log) },
	}}
}

// authRebuild describes one table that loses its user column. The new shape is
// written out here, not borrowed from the store's current schema, so a later
// change to the store cannot change what this step does to a database.
type authRebuild struct {
	table string
	// column is the user column being dropped.
	column string
	// copyAll keeps every row. The request log records what the instance sent
	// to the forges, so it never belonged to a user; only its account column goes.
	copyAll bool
	ddl     string
	columns string
	// legacy adds columns that a release added after the table was first
	// created, so the copy can name them on any older database.
	legacy []string
}

var authRebuilds = []authRebuild{
	{
		table: "sessions", column: "user_id",
		ddl: `CREATE TABLE sessions (
			token TEXT PRIMARY KEY,
			expires_at TIMESTAMP NOT NULL,
			created_at TIMESTAMP NOT NULL
		)`,
		columns: `token, expires_at, created_at`,
	},
	{
		table: "api_tokens", column: "user_id",
		ddl: `CREATE TABLE api_tokens (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			created_at TIMESTAMP NOT NULL,
			expires_at TIMESTAMP,
			last_used_at TIMESTAMP
		)`,
		columns: `id, label, token_hash, created_at, expires_at, last_used_at`,
		legacy:  []string{`ALTER TABLE api_tokens ADD COLUMN expires_at TIMESTAMP`},
	},
	{
		table: "credential_metadata", column: "user_id",
		ddl: `CREATE TABLE credential_metadata (
			credential_id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			created_at TIMESTAMP NOT NULL
		)`,
		columns: `credential_id, label, created_at`,
	},
	{
		table: "request_log", column: "account_id", copyAll: true,
		ddl: `CREATE TABLE request_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			logged_at TIMESTAMP NOT NULL,
			forge TEXT NOT NULL,
			method TEXT NOT NULL,
			endpoint TEXT NOT NULL,
			status_code INTEGER,
			outcome TEXT NOT NULL,
			rate_limit_limit INTEGER,
			rate_limit_remaining INTEGER,
			rate_limit_resets_at TIMESTAMP,
			rate_limit_cost INTEGER
		)`,
		columns: `id, logged_at, forge, method, endpoint, status_code, outcome, rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost`,
	},
}

// preflightDropUserID refuses what the step would refuse, before the backup is
// taken. It only reads. It is a courtesy so a refused start leaves no backup:
// the settings step runs before this one and can change what this one sees (it
// drops tables and rows), so the check inside the step's own transaction is the
// authority and repeats every refusal.
func preflightDropUserID(ctx context.Context, q dbmigrate.Tx) error {
	pending, err := pendingRebuilds(ctx, q)
	if err != nil || len(pending) == 0 {
		return err
	}
	owner, err := chooseAuthOwner(ctx, q, pending)
	if err != nil {
		return err
	}

	return checkNoOrphans(ctx, q, pending, owner)
}

func dropAuthUserID(ctx context.Context, tx dbmigrate.Tx, log *slog.Logger) error {
	pending, err := pendingRebuilds(ctx, tx)
	if err != nil || len(pending) == 0 {
		return err
	}
	owner, err := chooseAuthOwner(ctx, tx, pending)
	if err != nil {
		return err
	}
	if err := checkNoOrphans(ctx, tx, pending, owner); err != nil {
		return err
	}
	for _, r := range pending {
		if err := r.logDropped(ctx, tx, owner, log); err != nil {
			return err
		}
		if err := r.rebuild(ctx, tx, owner); err != nil {
			return err
		}
	}

	return nil
}

// pendingRebuilds lists the tables that still have their user column. A table
// that is missing or already has the new shape is skipped, so the step is safe
// to replay and a table no release created yet is left to the store.
func pendingRebuilds(ctx context.Context, q dbmigrate.Tx) ([]authRebuild, error) {
	var pending []authRebuild
	for _, r := range authRebuilds {
		var n int
		if err := q.QueryRowContext(ctx,
			`SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, r.table, r.column).Scan(&n); err != nil {
			return nil, fmt.Errorf("look at %s: %w", r.table, err)
		}
		if n > 0 {
			pending = append(pending, r)
		}
	}

	return pending, nil
}

// chooseAuthOwner returns the id whose rows survive: the user Store.Owner
// returns, which is the user the single-user cleanup keeps. Several users with
// no cleanup marker are refused when one holds a passkey, since the previous
// release settles that. When none does, that release never will, so the upgrade
// goes on only if no other user holds a session, token or passkey label: those
// are live credentials, and the oldest row wins only over abandoned
// registrations. With no user at all it refuses when a table holds rows that
// would be dropped.
func chooseAuthOwner(ctx context.Context, q dbmigrate.Tx, pending []authRebuild) (string, error) {
	users, err := countUsers(ctx, q)
	if err != nil {
		return "", err
	}
	if users == 0 {
		return "", requireNoOwnedRows(ctx, q, pending)
	}
	cleaned, err := cleanupMarkerExists(ctx, q)
	if err != nil {
		return "", err
	}

	var id string
	if err := q.QueryRowContext(ctx, `SELECT id FROM users `+OwnerOrder).Scan(&id); err != nil {
		return "", fmt.Errorf("find the owner: %w", err)
	}
	if users == 1 || cleaned {
		return id, nil
	}

	var holders int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM users WHERE credentials_json != '[]'`).Scan(&holders); err != nil {
		return "", fmt.Errorf("count users with a passkey: %w", err)
	}
	if holders > 0 {
		return "", fmt.Errorf("%w: run the previous release first, then this one", ErrSeveralUsers)
	}
	if err := requireOthersHoldNothing(ctx, q, pending, id); err != nil {
		return "", err
	}

	return id, nil
}

// otherUserNames lists the usernames, other than the owner's, that hold rows in
// the table.
func (r authRebuild) otherUserNames(ctx context.Context, q dbmigrate.Tx, owner string) ([]string, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT DISTINCT u.username FROM `+r.table+` t JOIN users u ON u.id = t.`+r.column+` WHERE t.`+r.column+` != ? ORDER BY u.username`, owner)
	if err != nil {
		return nil, fmt.Errorf("list the other users in %s: %w", r.table, err)
	}
	defer func() { _ = rows.Close() }()

	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, fmt.Errorf("list the other users in %s: %w", r.table, err)
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list the other users in %s: %w", r.table, err)
	}

	return names, nil
}

func cleanupMarkerExists(ctx context.Context, q dbmigrate.Tx) (bool, error) {
	var marker int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, singleuser.MarkerTable).Scan(&marker); err != nil {
		return false, fmt.Errorf("look for the cleanup marker: %w", err)
	}

	return marker > 0, nil
}

// requireOthersHoldNothing refuses to drop a live session, token or passkey
// label of a user other than the owner. ResetPasskeys keeps API tokens, so a
// user with no passkey can still hold working tokens.
func requireOthersHoldNothing(ctx context.Context, q dbmigrate.Tx, pending []authRebuild, owner string) error {
	for _, r := range pending {
		if r.copyAll {
			continue
		}
		names, err := r.otherUserNames(ctx, q, owner)
		if err != nil {
			return err
		}
		if len(names) > 0 {
			return fmt.Errorf("%w: no user holds a passkey, so the previous release cannot settle it, but %s still holds rows for %s; copy the database file, delete the users you do not want from users and their rows from %s, then start again, or restore a backup",
				ErrSeveralUsers, strings.Join(names, ", "), r.table, r.table)
		}
	}

	return nil
}

func countUsers(ctx context.Context, q dbmigrate.Tx) (int, error) {
	var has int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'`).Scan(&has); err != nil {
		return 0, fmt.Errorf("look for the users table: %w", err)
	}
	if has == 0 {
		return 0, nil
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}

	return n, nil
}

func requireNoOwnedRows(ctx context.Context, q dbmigrate.Tx, pending []authRebuild) error {
	for _, r := range pending {
		if r.copyAll {
			continue
		}
		n, err := r.count(ctx, q, r.table, "")
		if err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: %s holds %d rows and the users table is empty or missing; restore a backup", ErrNoOwner, r.table, n)
		}
	}

	return nil
}

// checkNoOrphans stops on rows keyed to a user id that is not in users, even
// beside the owner's own, unless the single-user cleanup ran on this database
// (then it dropped such rows itself and the step logs them). Rows of another
// user who still exists are different: the owner wins, and the step logs what
// it drops.
func checkNoOrphans(ctx context.Context, q dbmigrate.Tx, pending []authRebuild, owner string) error {
	if owner == "" {
		return nil
	}
	cleaned, err := cleanupMarkerExists(ctx, q)
	if err != nil || cleaned {
		return err
	}
	for _, r := range pending {
		if r.copyAll {
			continue
		}
		ids, err := r.orphanIDs(ctx, q)
		if err != nil {
			return err
		}
		if len(ids) > 0 {
			return fmt.Errorf("%w: %s has rows for user ids that are not in users (%s); copy the database file, delete them with DELETE FROM %s WHERE %s IN (%s), then start again, or restore a backup",
				ErrOrphanRows, r.table, strings.Join(ids, ", "), r.table, r.column, quoteAll(ids))
		}
	}

	return nil
}

func quoteAll(ids []string) string {
	quoted := make([]string, 0, len(ids))
	for _, id := range ids {
		quoted = append(quoted, "'"+strings.ReplaceAll(id, "'", "''")+"'")
	}

	return strings.Join(quoted, ", ")
}

// orphanIDs lists the user ids in the table that are not in users.
func (r authRebuild) orphanIDs(ctx context.Context, q dbmigrate.Tx) ([]string, error) {
	return r.ids(ctx, q, `SELECT DISTINCT `+r.column+` FROM `+r.table+` WHERE `+r.column+` NOT IN (SELECT id FROM users) ORDER BY `+r.column)
}

// otherIDs lists the user ids in the table other than the owner's, whether or
// not they are in users. Names are constants of this file, never input.
func (r authRebuild) otherIDs(ctx context.Context, q dbmigrate.Tx, owner string) ([]string, error) {
	return r.ids(ctx, q, `SELECT DISTINCT `+r.column+` FROM `+r.table+` WHERE `+r.column+` != ? ORDER BY `+r.column, owner)
}

func (r authRebuild) ids(ctx context.Context, q dbmigrate.Tx, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list the other user ids in %s: %w", r.table, err)
	}
	defer func() { _ = rows.Close() }()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("list the other user ids in %s: %w", r.table, err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list the other user ids in %s: %w", r.table, err)
	}

	return ids, nil
}

func (r authRebuild) countOthers(ctx context.Context, q dbmigrate.Tx, table, owner string) (int, error) {
	var n int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM `+table+` WHERE `+r.column+` != ?`, owner).Scan(&n); err != nil {
		return 0, fmt.Errorf("count the other rows of %s: %w", table, err)
	}

	return n, nil
}

func (r authRebuild) count(ctx context.Context, q dbmigrate.Tx, table, owner string) (int, error) {
	query := `SELECT count(*) FROM ` + table
	var args []any
	if owner != "" {
		query += ` WHERE ` + r.column + ` = ?`
		args = append(args, owner)
	}
	var n int
	if err := q.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("count %s: %w", table, err)
	}

	return n, nil
}

// logDropped says which other user ids' rows a table loses to the owner's,
// whether the user still exists or the rows are orphans nobody could reach. The
// old cleanup removed orphans without a word, so they never stop the start.
// They are in the backup taken first. Ids are logged, never tokens or hashes.
func (r authRebuild) logDropped(ctx context.Context, q dbmigrate.Tx, owner string, log *slog.Logger) error {
	if r.copyAll {
		return nil
	}
	ids, err := r.otherIDs(ctx, q, owner)
	if err != nil || len(ids) == 0 {
		return err
	}
	total, err := r.count(ctx, q, r.table, "")
	if err != nil {
		return err
	}
	mine, err := r.count(ctx, q, r.table, owner)
	if err != nil {
		return err
	}
	log.Warn("migrate: the owner's rows win; rows of other user ids are dropped and kept only in the backup",
		slog.String("table", r.table),
		slog.Int("dropped_rows", total-mine),
		slog.String("user_id", strings.Join(ids, ",")))

	return nil
}

// rebuild swaps one table for its new shape, copying the owner's rows (all of
// them for copyAll) and counting them before the old table goes.
func (r authRebuild) rebuild(ctx context.Context, tx dbmigrate.Tx, owner string) error {
	for _, stmt := range r.legacy {
		if _, err := tx.ExecContext(ctx, stmt); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add a missing column to %s: %w", r.table, err)
		}
	}
	aside := r.table + "_old"
	// Every name and column list below is a constant of this file, never input.
	if _, err := tx.ExecContext(ctx, `ALTER TABLE `+r.table+` RENAME TO `+aside); err != nil {
		return fmt.Errorf("set %s aside: %w", r.table, err)
	}
	if _, err := tx.ExecContext(ctx, r.ddl); err != nil {
		return fmt.Errorf("create %s: %w", r.table, err)
	}
	insert := `INSERT INTO ` + r.table + ` (` + r.columns + `) SELECT ` + r.columns + ` FROM ` + aside
	var args []any
	if !r.copyAll {
		insert += ` WHERE ` + r.column + ` = ?`
		args = append(args, owner)
	}
	if _, err := tx.ExecContext(ctx, insert, args...); err != nil {
		return fmt.Errorf("copy %s: %w", r.table, err)
	}

	// Count what should arrive without the filter the copy used: every source
	// row, less the rows that belong to other user ids and are dropped on
	// purpose. A row the filter missed (a NULL id, say) is then a shortfall.
	total, err := r.count(ctx, tx, aside, "")
	if err != nil {
		return err
	}
	expected := total
	if !r.copyAll {
		dropped, err := r.countOthers(ctx, tx, aside, owner)
		if err != nil {
			return err
		}
		expected = total - dropped
	}
	got, err := r.count(ctx, tx, r.table, "")
	if err != nil {
		return err
	}
	if got != expected {
		return fmt.Errorf("%w: %s should have %d rows, %d were copied", ErrCopyIncomplete, r.table, expected, got)
	}
	if _, err := tx.ExecContext(ctx, `DROP TABLE `+aside); err != nil {
		return fmt.Errorf("drop old %s: %w", r.table, err)
	}

	return nil
}
