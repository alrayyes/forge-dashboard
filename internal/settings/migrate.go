package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/alrayyes/forge-dashboard/internal/singleuser"
)

// ErrRunPreviousRelease is returned when the database still holds several users
// that the one-time single-user cleanup has not settled. Dropping the user id
// would merge their settings into one row, so the migration refuses.
var ErrRunPreviousRelease = errors.New("settings: the database has several users and the single-user cleanup has not run")

// MigrationSteps are the schema steps for the settings tables, in order. Pass
// them to dbmigrate.Run before any store creates its tables.
func MigrationSteps() []dbmigrate.Step {
	return []dbmigrate.Step{{Name: "drop the user id from the settings tables", Run: dropUserID}}
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

// dropUserID rebuilds each table that still has a user_id column without it,
// following SQLite's table-rebuild procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
// the old table is renamed aside, the new one created, the owner's rows copied,
// the old one dropped. A table that is missing or already has the new shape is
// skipped, so the step is safe to replay and a table no release created yet is
// left to the store.
func dropUserID(ctx context.Context, tx dbmigrate.Tx) error {
	pending, err := tablesWithUserID(ctx, tx)
	if err != nil {
		return err
	}
	if len(pending) == 0 {
		return nil
	}

	owner, err := soleUser(ctx, tx)
	if err != nil {
		return err
	}

	for _, r := range pending {
		if err := r.rebuild(ctx, tx, owner); err != nil {
			return err
		}
	}

	return nil
}

// rebuild swaps one table for its new shape, copying the owner's rows.
func (r rebuild) rebuild(ctx context.Context, tx dbmigrate.Tx, owner string) error {
	if err := addLegacyColumns(ctx, tx, r.old); err != nil {
		return err
	}
	aside := r.old + "_old"
	// Every name and column list below is a constant of this file, never input.
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
	insert := `INSERT INTO ` + r.new + ` (` + target + `) SELECT ` + selected + ` FROM ` + aside + ` WHERE user_id = ?` //nolint:gosec // constants of this file
	if _, err := tx.ExecContext(ctx, insert, owner); err != nil {
		return fmt.Errorf("copy %s: %w", r.old, err)
	}
	if _, err := tx.ExecContext(ctx, `DROP TABLE `+aside); err != nil {
		return fmt.Errorf("drop old %s: %w", r.old, err)
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

// soleUser returns the id whose rows survive. With several users and no
// cleanup marker it refuses. With the marker, or one user, the owner is the
// oldest user holding a passkey, else the oldest user. The empty string, when
// no user exists, matches no row, so nothing is copied.
func soleUser(ctx context.Context, tx dbmigrate.Tx) (string, error) {
	var hasUsers, hasMarker int
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'users'`).Scan(&hasUsers); err != nil {
		return "", fmt.Errorf("look for the users table: %w", err)
	}
	if hasUsers == 0 {
		return "", nil
	}
	if err := tx.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, singleuser.MarkerTable).Scan(&hasMarker); err != nil {
		return "", fmt.Errorf("look for the cleanup marker: %w", err)
	}
	var users int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM users`).Scan(&users); err != nil {
		return "", fmt.Errorf("count users: %w", err)
	}
	if users > 1 && hasMarker == 0 {
		return "", fmt.Errorf("%w: run the previous release first, then this one", ErrRunPreviousRelease)
	}

	var id string
	err := tx.QueryRowContext(ctx,
		`SELECT id FROM users ORDER BY (credentials_json = '[]'), created_at, rowid LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("find the owner: %w", err)
	}

	return id, nil
}
