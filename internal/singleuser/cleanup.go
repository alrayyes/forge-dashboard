// Package singleuser turns a database that grew several users into one with a
// single owner. Run is called once at startup, after every store has created
// its tables: it keeps the oldest registered user, copies the database aside,
// and deletes every other user with all their data in one transaction.
package singleuser

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"
)

// markerTable records that the cleanup has run, so it never runs again on a
// database that has settled on one user.
const markerTable = "single_user_cleanup"

// ownedTable is a table whose rows belong to a user, found through column.
type ownedTable struct {
	name   string
	column string
}

// owned lists every table holding a user's data. The test that lists
// sqlite_master fails when a table exists that is neither here nor handled by
// hand below (users, ceremonies, the marker). The cache tables (http_etags,
// snapshot_cache, hook_checks, webhook_seen) are keyed by credential and repo,
// hold no user, and are left alone.
var owned = []ownedTable{
	{"sessions", "user_id"},
	{"api_tokens", "user_id"},
	{"credential_metadata", "user_id"},
	{"request_log", "account_id"},
	{"user_credentials", "user_id"},
	{"webhook_deliveries", "user_id"},
	{"ignored_repos", "user_id"},
	{"auto_update_branch_repos", "user_id"},
	{"auto_merge_intents", "user_id"},
	{"hidden_pull_requests", "user_id"},
	{"queued_actions", "user_id"},
	{"pull_request_auto_update", "user_id"},
}

// Result says what Run did.
type Result struct {
	// Ran is true when a cleanup was recorded this start.
	Ran bool
	// Kept is the username of the user the instance kept.
	Kept string
	// Removed is how many other users were deleted.
	Removed int
	// BackupPath is the copy taken before deleting, empty when none was needed.
	BackupPath string
}

type user struct {
	id        string
	username  string
	createdAt time.Time
}

// Run keeps the oldest user holding a passkey and deletes the rest. It does
// nothing on an empty database or after the marker was written. If the backup
// or the transaction fails nothing is deleted and the error is returned; the
// next start tries again.
func Run(ctx context.Context, db *sql.DB, dbPath string, log *slog.Logger) (Result, error) {
	done, err := markerExists(ctx, db)
	if err != nil {
		return Result{}, err
	}
	if done {
		return Result{}, nil
	}

	keeper, found, err := oldestRegistered(ctx, db)
	if err != nil {
		return Result{}, err
	}
	if !found {
		log.Info("single-user cleanup: nothing to clean up, no registered user yet")

		return Result{}, nil
	}

	others, err := otherUsers(ctx, db, keeper.id)
	if err != nil {
		return Result{}, err
	}

	res := Result{Kept: keeper.username, Removed: len(others)}
	if len(others) > 0 {
		res.BackupPath, err = backUp(ctx, db, dbPath)
		if err != nil {
			return Result{}, err
		}
	}

	removed, err := deleteOthers(ctx, db, keeper, others)
	if err != nil {
		return Result{}, err
	}

	for _, r := range removed {
		log.Warn("single-user cleanup: removed user",
			slog.String("username", r.user.username),
			slog.Time("created_at", r.user.createdAt),
			slog.Any("rows", r.rows))
	}
	log.Info("single-user cleanup: done",
		slog.String("kept", keeper.username),
		slog.Int("removed_users", len(others)),
		slog.String("backup", res.BackupPath))
	res.Ran = true

	return res, nil
}

// backUp copies the database next to the original. The copy holds every
// secret the database does, so the file is created 0600 before SQLite writes
// to it (VACUUM INTO accepts an existing empty file), never wider. O_EXCL makes
// a name clash fail instead of overwriting an earlier backup, and the name
// carries nanoseconds so two starts in one second do not clash.
func backUp(ctx context.Context, db *sql.DB, dbPath string) (string, error) {
	path := fmt.Sprintf("%s.before-single-user-%s", dbPath, time.Now().UTC().Format("20060102T150405.000000000Z"))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600) //nolint:gosec // path is the configured database path plus a fixed suffix
	if err != nil {
		return "", fmt.Errorf("single-user cleanup: create the backup: %w", err)
	}
	if err := f.Close(); err != nil {
		return "", fmt.Errorf("single-user cleanup: create the backup: %w", err)
	}
	if _, err := db.ExecContext(ctx, `VACUUM INTO ?`, path); err != nil {
		_ = os.Remove(path)

		return "", fmt.Errorf("single-user cleanup: back up the database: %w", err)
	}

	return path, nil
}

func markerExists(ctx context.Context, db *sql.DB) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, markerTable).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("single-user cleanup: look for the marker: %w", err)
	}

	return n > 0, nil
}

// oldestRegistered is the keeper: the oldest user holding a passkey. A row
// with none is an abandoned registration, not the first user.
func oldestRegistered(ctx context.Context, db *sql.DB) (user, bool, error) {
	var u user
	err := db.QueryRowContext(ctx,
		`SELECT id, username, created_at FROM users WHERE credentials_json != '[]' ORDER BY created_at, rowid LIMIT 1`,
	).Scan(&u.id, &u.username, &u.createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return user{}, false, nil
	}
	if err != nil {
		return user{}, false, fmt.Errorf("single-user cleanup: find the oldest user: %w", err)
	}

	return u, true, nil
}

func otherUsers(ctx context.Context, db *sql.DB, keeperID string) ([]user, error) {
	rows, err := db.QueryContext(ctx, `SELECT id, username, created_at FROM users WHERE id != ? ORDER BY created_at, rowid`, keeperID)
	if err != nil {
		return nil, fmt.Errorf("single-user cleanup: list the other users: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var others []user
	for rows.Next() {
		var u user
		if err := rows.Scan(&u.id, &u.username, &u.createdAt); err != nil {
			return nil, fmt.Errorf("single-user cleanup: read a user: %w", err)
		}
		others = append(others, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("single-user cleanup: list the other users: %w", err)
	}

	return others, nil
}

type removal struct {
	user user
	rows map[string]int64
}

// deleteOthers removes every other user and their data, and writes the marker,
// in one transaction: either all of it happens or none.
func deleteOthers(ctx context.Context, db *sql.DB, keeper user, others []user) ([]removal, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("single-user cleanup: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	removed := make([]removal, 0, len(others))
	for _, u := range others {
		rows, err := deleteUserRows(ctx, tx, u)
		if err != nil {
			return nil, err
		}
		removed = append(removed, removal{user: u, rows: rows})
	}
	if err := deleteLeftovers(ctx, tx, keeper); err != nil {
		return nil, err
	}
	if err := WriteMarker(ctx, tx, keeper.username, len(others)); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("single-user cleanup: commit: %w", err)
	}

	return removed, nil
}

// deleteUserRows removes u's rows from every table but users itself, which
// goes last, and counts them per table for the log.
func deleteUserRows(ctx context.Context, tx *sql.Tx, u user) (map[string]int64, error) {
	rows := map[string]int64{}
	for _, t := range owned {
		n, err := execCount(ctx, tx, fmt.Sprintf(`DELETE FROM %s WHERE %s = ?`, t.name, t.column), u.id)
		if err != nil {
			return nil, fmt.Errorf("single-user cleanup: delete %s of %s: %w", t.name, u.username, err)
		}
		rows[t.name] = n
	}
	n, err := execCount(ctx, tx, `DELETE FROM ceremonies WHERE username = ?`, u.username)
	if err != nil {
		return nil, fmt.Errorf("single-user cleanup: delete ceremonies of %s: %w", u.username, err)
	}
	rows["ceremonies"] = n

	return rows, nil
}

// deleteLeftovers removes the other users. Rows of users that no longer exist
// (the removed admin "remove user" action left some behind) go too: only the
// kept user's rows may remain.
func deleteLeftovers(ctx context.Context, tx *sql.Tx, keeper user) error {
	for _, t := range owned {
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`DELETE FROM %s WHERE %s != ?`, t.name, t.column), keeper.id); err != nil {
			return fmt.Errorf("single-user cleanup: delete stray %s rows: %w", t.name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id != ?`, keeper.id); err != nil {
		return fmt.Errorf("single-user cleanup: delete users: %w", err)
	}

	return nil
}

// WriteMarker records that the cleanup is settled for this database. Run calls
// it after deleting; the first passkey registration on an instance calls it
// too, because such an instance never held several users from before the
// upgrade.
func WriteMarker(ctx context.Context, tx *sql.Tx, keptUsername string, removedUsers int) error {
	if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS `+markerTable+` (
		ran_at TIMESTAMP NOT NULL,
		kept_username TEXT NOT NULL,
		removed_users INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("single-user cleanup: create the marker table: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO `+markerTable+` (ran_at, kept_username, removed_users) VALUES (?, ?, ?)`,
		time.Now().UTC(), keptUsername, removedUsers,
	); err != nil {
		return fmt.Errorf("single-user cleanup: write the marker: %w", err)
	}

	return nil
}

func execCount(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	res, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err //nolint:wrapcheck // callers add the table
	}

	return res.RowsAffected() //nolint:wrapcheck // callers add the table
}
