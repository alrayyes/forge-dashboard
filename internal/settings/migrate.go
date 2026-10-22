package settings

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/alrayyes/forge-dashboard/internal/singleuser"
)

// ErrRunPreviousRelease is returned when the database still holds several users
// that the one-time single-user cleanup has not settled. Dropping the user id
// would merge their settings into one row, so the migration refuses.
var ErrRunPreviousRelease = errors.New("settings: the database has several users and the single-user cleanup has not run")

// ErrNoPasskeyHolder is returned when the database has several users, none of
// them holding a passkey. The single-user cleanup keeps the oldest user with a
// passkey, so it can't pick one here and never writes its marker: running the
// previous release won't settle it.
var ErrNoPasskeyHolder = errors.New("settings: the database has several users and none holds a passkey")

// ErrNoOwner is returned when the settings tables hold rows but there is no
// user to attach them to. Copying nothing and dropping the old tables would
// lose them.
var ErrNoOwner = errors.New("settings: the settings tables hold rows but no user owns them")

// ErrCopyIncomplete is returned when a table's rows did not all reach its new
// shape. The step rolls back, so the old table is still there.
var ErrCopyIncomplete = errors.New("settings: rows were lost in the copy")

// ErrSettingsTableInTheWay is returned when a settings table already exists
// beside user_credentials and holds rows. Replacing it would overwrite them.
var ErrSettingsTableInTheWay = errors.New("settings: a settings table with rows already exists beside user_credentials")

// MigrationSteps are the schema steps for the settings tables, in order. Pass
// them to dbmigrate.Run before any store creates its tables.
func MigrationSteps() []dbmigrate.Step {
	tables := make([]string, 0, len(rebuilds))
	for _, r := range rebuilds {
		tables = append(tables, r.new)
	}

	return []dbmigrate.Step{{Name: "drop the user id from the settings tables", Tables: tables, Preflight: preflight, Run: dropUserID}}
}

// rebuild describes one table that loses its user id. The new shape is written
// out here, not borrowed from the store's current schema, so a later change to
// the store cannot change what this step does to a database.
type rebuild struct {
	old, new string
	// ddl creates the new table.
	ddl string
	// columns are copied across by name; id is added for the one-row settings table.
	columns string
}

var rebuilds = []rebuild{
	{
		old: "user_credentials", new: "settings",
		ddl: `CREATE TABLE settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			github_token TEXT NOT NULL DEFAULT '',
			github_username TEXT NOT NULL DEFAULT '',
			forgejo_url TEXT NOT NULL DEFAULT '',
			forgejo_token TEXT NOT NULL DEFAULT '',
			forgejo_username TEXT NOT NULL DEFAULT '',
			webhook_token TEXT NOT NULL DEFAULT '',
			webhook_secret TEXT NOT NULL DEFAULT '',
			renovate_rebase_label TEXT NOT NULL DEFAULT '',
			renovate_authors TEXT NOT NULL DEFAULT '',
			hide_dependency_dashboard INTEGER NOT NULL DEFAULT 0,
			ignored_titles TEXT NOT NULL DEFAULT '[]',
			filter_state TEXT NOT NULL DEFAULT '{}',
			theme TEXT NOT NULL DEFAULT '',
			timezone TEXT NOT NULL DEFAULT '',
			github_app_installation_id INTEGER NOT NULL DEFAULT 0,
			updated_at TIMESTAMP NOT NULL
		)`,
		columns: `github_token, github_username, forgejo_url, forgejo_token, forgejo_username, webhook_token, webhook_secret, renovate_rebase_label, renovate_authors, hide_dependency_dashboard, ignored_titles, filter_state, theme, timezone, github_app_installation_id, updated_at`,
	},
	{
		old: "webhook_deliveries", new: "webhook_deliveries",
		ddl: `CREATE TABLE webhook_deliveries (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			last_seen_at TIMESTAMP NOT NULL,
			PRIMARY KEY (forge, repo_full_name)
		)`,
		columns: `forge, repo_full_name, last_seen_at`,
	},
	{
		old: "ignored_repos", new: "ignored_repos",
		ddl: `CREATE TABLE ignored_repos (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			ignore_prs BOOLEAN NOT NULL DEFAULT 1,
			ignore_issues BOOLEAN NOT NULL DEFAULT 1,
			PRIMARY KEY (forge, repo_full_name)
		)`,
		columns: `forge, repo_full_name, ignore_prs, ignore_issues`,
	},
	{
		old: "auto_update_branch_repos", new: "auto_update_branch_repos",
		ddl: `CREATE TABLE auto_update_branch_repos (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			PRIMARY KEY (forge, repo_full_name)
		)`,
		columns: `forge, repo_full_name`,
	},
	{
		old: "auto_merge_intents", new: "auto_merge_intents",
		ddl: `CREATE TABLE auto_merge_intents (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			number INTEGER NOT NULL,
			armed_at TIMESTAMP NOT NULL,
			PRIMARY KEY (forge, repo_full_name, number)
		)`,
		columns: `forge, repo_full_name, number, armed_at`,
	},
	{
		old: "hidden_pull_requests", new: "hidden_pull_requests",
		ddl: `CREATE TABLE hidden_pull_requests (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			number INTEGER NOT NULL,
			hidden_until TIMESTAMP,
			PRIMARY KEY (forge, repo_full_name, number)
		)`,
		columns: `forge, repo_full_name, number, hidden_until`,
	},
	{
		old: "queued_actions", new: "queued_actions",
		ddl: `CREATE TABLE queued_actions (
			id TEXT PRIMARY KEY,
			action TEXT NOT NULL,
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			number INTEGER NOT NULL,
			status TEXT NOT NULL,
			run_at TIMESTAMP NOT NULL,
			created_at TIMESTAMP NOT NULL,
			finished_at TIMESTAMP,
			code TEXT NOT NULL DEFAULT '',
			message TEXT NOT NULL DEFAULT ''
		)`,
		columns: `id, action, forge, repo_full_name, number, status, run_at, created_at, finished_at, code, message`,
	},
	{
		old: "pull_request_auto_update", new: "pull_request_auto_update",
		ddl: `CREATE TABLE pull_request_auto_update (
			forge TEXT NOT NULL,
			repo_full_name TEXT NOT NULL,
			number INTEGER NOT NULL,
			enabled BOOLEAN NOT NULL,
			PRIMARY KEY (forge, repo_full_name, number)
		)`,
		columns: `forge, repo_full_name, number, enabled`,
	},
}

// legacyColumns are columns that releases added to these tables after they were
// first created. A database that never saw them gets them here, before the
// copy names them, so the copy works from any older shape.
var legacyColumns = []string{
	`ALTER TABLE user_credentials ADD COLUMN webhook_token TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN renovate_rebase_label TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN filter_state TEXT NOT NULL DEFAULT '{}'`,
	`ALTER TABLE user_credentials ADD COLUMN theme TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN timezone TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN github_app_installation_id INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE user_credentials ADD COLUMN renovate_authors TEXT NOT NULL DEFAULT ''`,
	`ALTER TABLE user_credentials ADD COLUMN hide_dependency_dashboard INTEGER NOT NULL DEFAULT 0`,
	`ALTER TABLE user_credentials ADD COLUMN ignored_titles TEXT NOT NULL DEFAULT '[]'`,
	`ALTER TABLE ignored_repos ADD COLUMN ignore_prs BOOLEAN NOT NULL DEFAULT 1`,
	`ALTER TABLE ignored_repos ADD COLUMN ignore_issues BOOLEAN NOT NULL DEFAULT 1`,
}

// preflight refuses what the step would refuse, before the backup is taken: an
// owner that can't be chosen, rows with no owner, or a settings table in the
// way. It only reads.
func preflight(ctx context.Context, q dbmigrate.Tx) error {
	pending, err := tablesWithUserID(ctx, q)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}
	if err := checkSettingsTableFree(ctx, q, pending); err != nil {
		return err
	}
	owner, err := chooseOwner(ctx, q, pending)
	if err != nil {
		return err
	}

	return checkOwnerHasRows(ctx, q, pending, owner)
}

// dropUserID rebuilds each table that still has a user_id column without it,
// following SQLite's table-rebuild procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
// the old table is renamed aside, the new one created, the owner's rows copied,
// the copy counted, the old one dropped. A table that is missing or already has
// the new shape is skipped, so the step is safe to replay and a table no
// release created yet is left to the store.
func dropUserID(ctx context.Context, tx dbmigrate.Tx) error {
	pending, err := tablesWithUserID(ctx, tx)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}
	if err := checkSettingsTableFree(ctx, tx, pending); err != nil {
		return err
	}

	owner, err := chooseOwner(ctx, tx, pending)
	if err != nil {
		return err
	}

	if err := checkOwnerHasRows(ctx, tx, pending, owner); err != nil {
		return err
	}

	for _, r := range pending {
		if err := r.rebuild(ctx, tx, owner); err != nil {
			return err
		}
	}

	return nil
}

// checkOwnerHasRows refuses a table that holds rows when none of them belong to
// the owner: copying would leave it empty and the old rows would be dropped. It
// runs in the preflight so that the refusal happens before the backup.
func checkOwnerHasRows(ctx context.Context, q dbmigrate.Tx, pending []rebuild, owner string) error {
	for _, r := range pending {
		total, err := countRows(ctx, q, r.old, "")
		if err != nil {
			return err
		}
		mine, err := countRows(ctx, q, r.old, owner)
		if err != nil {
			return err
		}
		if total > 0 && mine == 0 {
			return fmt.Errorf("%w: %s had %d rows, %d belong to the owner, 0 were copied", ErrCopyIncomplete, r.old, total, mine)
		}
	}

	return nil
}

// checkSettingsTableFree makes room for the new settings table. One can only
// exist already if something created it in the new shape beside
// user_credentials. An empty one is dropped; one with rows is not ours to
// overwrite.
func checkSettingsTableFree(ctx context.Context, q dbmigrate.Tx, pending []rebuild) error {
	for _, r := range pending {
		if r.new == r.old {
			continue
		}
		var exists int
		if err := q.QueryRowContext(ctx,
			`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, r.new).Scan(&exists); err != nil {
			return fmt.Errorf("look for %s: %w", r.new, err)
		}
		if exists == 0 {
			continue
		}
		rows, err := countRows(ctx, q, r.new, "")
		if err != nil {
			return err
		}
		if rows > 0 { // an empty one is dropped by the rebuild
			return fmt.Errorf("%w: move it aside or restore a backup, then start again", ErrSettingsTableInTheWay)
		}
	}

	return nil
}

// countRows counts a table's rows, those of one user when owner is not empty.
// Table names are constants of this file, never input.
func countRows(ctx context.Context, q dbmigrate.Tx, table, owner string) (int, error) {
	query := `SELECT count(*) FROM ` + table
	var args []any
	if owner != "" {
		query += ` WHERE user_id = ?`
		args = append(args, owner)
	}
	var n int
	if err := q.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("count %s: %w", table, err)
	}

	return n, nil
}

// rebuild swaps one table for its new shape, copying the owner's rows and
// counting them before the old table goes.
func (r rebuild) rebuild(ctx context.Context, tx dbmigrate.Tx, owner string) error {
	if err := addLegacyColumns(ctx, tx, r.old); err != nil {
		return err
	}
	aside := r.old + "_old"
	// Every name and column list below is a constant of this file, never input.
	if r.new != r.old {
		if _, err := tx.ExecContext(ctx, `DROP TABLE IF EXISTS `+r.new); err != nil { // checkSettingsTableFree let only an empty one through
			return fmt.Errorf("clear %s: %w", r.new, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE `+r.old+` RENAME TO `+aside); err != nil {
		return fmt.Errorf("set %s aside: %w", r.old, err)
	}
	if _, err := tx.ExecContext(ctx, r.ddl); err != nil {
		return fmt.Errorf("create %s: %w", r.new, err)
	}
	target, selected := r.columns, r.columns
	if r.new == "settings" {
		target, selected = "id, "+r.columns, "1, "+r.columns
	}
	insert := `INSERT INTO ` + r.new + ` (` + target + `) SELECT ` + selected + ` FROM ` + aside + ` WHERE user_id = ?`
	if _, err := tx.ExecContext(ctx, insert, owner); err != nil {
		return fmt.Errorf("copy %s: %w", r.old, err)
	}
	if err := r.verifyCopy(ctx, tx, aside, owner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DROP TABLE `+aside); err != nil {
		return fmt.Errorf("drop old %s: %w", r.old, err)
	}

	return nil
}

// verifyCopy compares the new table with the owner's rows in the old one, and
// refuses to go on when a table that held rows copied none. Dropping the old
// table after that would be unrecoverable inside the step.
func (r rebuild) verifyCopy(ctx context.Context, tx dbmigrate.Tx, aside, owner string) error {
	total, err := countRows(ctx, tx, aside, "")
	if err != nil {
		return err
	}
	want, err := countRows(ctx, tx, aside, owner)
	if err != nil {
		return err
	}
	got, err := countRows(ctx, tx, r.new, "")
	if err != nil {
		return err
	}
	if got != want || (total > 0 && got == 0) {
		return fmt.Errorf("%w: %s had %d rows, %d belong to the owner, %d were copied", ErrCopyIncomplete, r.old, total, want, got)
	}

	return nil
}

func tablesWithUserID(ctx context.Context, tx dbmigrate.Tx) ([]rebuild, error) {
	var pending []rebuild
	for _, r := range rebuilds {
		var n int
		err := tx.QueryRowContext(ctx,
			`SELECT count(*) FROM pragma_table_info(?) WHERE name = 'user_id'`, r.old,
		).Scan(&n)
		if err != nil {
			return nil, fmt.Errorf("look at %s: %w", r.old, err)
		}
		if n > 0 {
			pending = append(pending, r)
		}
	}

	return pending, nil
}

func addLegacyColumns(ctx context.Context, tx dbmigrate.Tx, table string) error {
	for _, stmt := range legacyColumns {
		if !strings.HasPrefix(stmt, `ALTER TABLE `+table+` `) {
			continue
		}
		if _, err := tx.ExecContext(ctx, stmt); err != nil && !strings.Contains(err.Error(), "duplicate column name") {
			return fmt.Errorf("add a missing column to %s: %w", table, err)
		}
	}

	return nil
}

// chooseOwner returns the id whose rows survive. With several users and no
// cleanup marker it refuses: the previous release's cleanup settles that, unless
// no user holds a passkey, when it never will. With the marker, or one user, the
// owner is the one auth.Store.Owner returns. With no user at all and rows to
// keep it refuses, since copying nothing would lose them.
func chooseOwner(ctx context.Context, q dbmigrate.Tx, pending []rebuild) (string, error) {
	users, err := countUsers(ctx, q)
	if err != nil {
		return "", err
	}
	if users == 0 {
		return "", requireNoRows(ctx, q, pending)
	}
	if users > 1 {
		if err := requireCleanupDone(ctx, q); err != nil {
			return "", err
		}
	}

	var id string
	if err := q.QueryRowContext(ctx, `SELECT id FROM users `+auth.OwnerOrder).Scan(&id); err != nil {
		return "", fmt.Errorf("find the owner: %w", err)
	}

	return id, nil
}

// requireNoRows is the no-owner case: fine while the old tables are empty,
// ErrNoOwner as soon as one holds a row that would be dropped.
func requireNoRows(ctx context.Context, q dbmigrate.Tx, pending []rebuild) error {
	for _, r := range pending {
		n, err := countRows(ctx, q, r.old, "")
		if err != nil {
			return err
		}
		if n > 0 {
			return fmt.Errorf("%w: %s holds %d rows and the users table is empty or missing; restore a backup", ErrNoOwner, r.old, n)
		}
	}

	return nil
}

// requireCleanupDone refuses several users until the single-user cleanup has
// settled them, and says which way out applies.
func requireCleanupDone(ctx context.Context, q dbmigrate.Tx) error {
	var hasMarker int
	if err := q.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, singleuser.MarkerTable).Scan(&hasMarker); err != nil {
		return fmt.Errorf("look for the cleanup marker: %w", err)
	}
	if hasMarker > 0 {
		return nil
	}
	var holders int
	if err := q.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE credentials_json != '[]'`).Scan(&holders); err != nil {
		return fmt.Errorf("count users with a passkey: %w", err)
	}
	if holders == 0 {
		return fmt.Errorf("%w: the single-user cleanup keeps the oldest user with a passkey, so it can't run and the previous release won't help; keep the one user you want in the users table (take a backup first) or restore a backup", ErrNoPasskeyHolder)
	}

	return fmt.Errorf("%w: run the previous release first, then this one", ErrRunPreviousRelease)
}

// countUsers counts the users, zero when the table doesn't exist.
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
