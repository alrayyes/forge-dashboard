package settings_test

import (
	"database/sql"
	_ "embed"
	"encoding/base64"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

//go:embed testdata/old_schema.sql
var oldSchema string

//go:embed testdata/old_rows.sql
var oldRows string

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// migrationTables are the tables the user id comes out of, by their new names.
var migrationTables = []string{
	"settings", "webhook_deliveries", "ignored_repos", "auto_update_branch_repos",
	"auto_merge_intents", "hidden_pull_requests", "queued_actions", "pull_request_auto_update",
}

func openMigrationDB(t *testing.T) (*sql.DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.db")
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	return db, path
}

func mustExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	_, err := db.ExecContext(t.Context(), query)
	require.NoError(t, err)
}

func scalar[T any](t *testing.T, db *sql.DB, query string, args ...any) T {
	t.Helper()
	var v T
	require.NoError(t, db.QueryRowContext(t.Context(), query, args...).Scan(&v))

	return v
}

func seedOldShape(t *testing.T, db *sql.DB) {
	t.Helper()
	mustExec(t, db, oldSchema)
	mustExec(t, db, oldRows)
}

func migrate(t *testing.T, db *sql.DB, path string) (dbmigrate.Result, error) {
	t.Helper()

	return dbmigrate.Run(t.Context(), db, path, settings.MigrationSteps(), quietLog) //nolint:wrapcheck // test helper
}

func hasColumn(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()

	return scalar[int](t, db, `SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, table, column) > 0
}

func tableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()

	return scalar[int](t, db, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table) > 0
}

func TestMigrate_OldShapeWithOneUser_KeepsEveryRowWithoutTheUserID(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 1, res.Applied)
	for _, table := range migrationTables {
		assert.False(t, hasColumn(t, db, table, "user_id"), table)
		assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM `+table), table)
	}
	assert.False(t, tableExists(t, db, "user_credentials"))
	assert.Equal(t, "sealed-gh", scalar[string](t, db, `SELECT github_token FROM settings`))
	assert.Equal(t, "sealed-fj", scalar[string](t, db, `SELECT forgejo_token FROM settings`))
	assert.Equal(t, "hook-token", scalar[string](t, db, `SELECT webhook_token FROM settings`))
	assert.Equal(t, "hook-secret", scalar[string](t, db, `SELECT webhook_secret FROM settings`))
	assert.Equal(t, "dark", scalar[string](t, db, `SELECT theme FROM settings`))
	assert.Equal(t, "Europe/Amsterdam", scalar[string](t, db, `SELECT timezone FROM settings`))
	assert.JSONEq(t, `{"q":"x"}`, scalar[string](t, db, `SELECT filter_state FROM settings`))
	assert.Equal(t, 42, scalar[int](t, db, `SELECT github_app_installation_id FROM settings`))
	assert.Equal(t, "abc123", scalar[string](t, db, `SELECT id FROM queued_actions`))
	assert.Equal(t, 0, scalar[int](t, db, `SELECT ignore_issues FROM ignored_repos`))
}

func TestMigrate_RunTwice_SecondRunChangesNothing(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrate(t, db, path)
	require.NoError(t, err)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, res.Applied)
	assert.Equal(t, "hook-token", scalar[string](t, db, `SELECT webhook_token FROM settings`))
}

func TestMigrate_StepRerunOnNewShape_IsANoOp(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrate(t, db, path)
	require.NoError(t, err)
	// A reset that emptied schema_version would make the runner replay the step.
	mustExec(t, db, `UPDATE schema_version SET version = 0`)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 1, res.Applied)
	assert.Equal(t, "hook-token", scalar[string](t, db, `SELECT webhook_token FROM settings`))
}

func TestMigrate_FailureMidStep_LeavesEveryOldTableIntact(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	// The step renames each old table aside; a squatter on that name makes it
	// fail after the tables before it were already rebuilt.
	mustExec(t, db, `CREATE TABLE hidden_pull_requests_old (x TEXT)`)

	_, err := migrate(t, db, path)

	require.Error(t, err)
	for _, table := range []string{
		"webhook_deliveries", "ignored_repos", "auto_update_branch_repos", "auto_merge_intents",
		"hidden_pull_requests", "queued_actions", "pull_request_auto_update", "user_credentials",
	} {
		assert.True(t, hasColumn(t, db, table, "user_id"), table)
		assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM `+table), table)
	}
	assert.False(t, tableExists(t, db, "settings"))
	assert.False(t, tableExists(t, db, "schema_version"), "a failed step writes no version")
}

func TestMigrate_FreshDatabase_CreatesNoOldTable(t *testing.T) {
	db, path := openMigrationDB(t)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, res.Applied)
	assert.Zero(t, scalar[int](t, db, `SELECT count(*) FROM sqlite_master WHERE name != 'schema_version'`))
}

func TestMigrate_SeveralUsersAndNoCleanupMarker_RefusesWithTheInstruction(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `INSERT INTO users (id, username, credentials_json, created_at) VALUES ('other', 'sam', '[{}]', '2026-06-01 00:00:00')`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrRunPreviousRelease)
	assert.Contains(t, err.Error(), "previous release")
	assert.True(t, hasColumn(t, db, "user_credentials", "user_id"))
}

func TestMigrate_SeveralUsersButCleanupMarker_KeepsOnlyTheOwnersRows(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `CREATE TABLE single_user_cleanup (ran_at TIMESTAMP NOT NULL, kept_username TEXT NOT NULL, removed_users INTEGER NOT NULL)`)
	mustExec(t, db, `INSERT INTO single_user_cleanup VALUES ('2026-07-01 00:00:00', 'ryan', 1)`)
	mustExec(t, db, `INSERT INTO users (id, username, credentials_json, created_at) VALUES ('other', 'sam', '[{}]', '2026-06-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO ignored_repos VALUES ('other', 'github', 'z/z', 1, 1)`)
	mustExec(t, db, `INSERT INTO user_credentials (user_id, webhook_token, updated_at) VALUES ('ghost', 'ghost-token', '2026-02-02 00:00:00')`)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM ignored_repos`))
	assert.Equal(t, "hook-token", scalar[string](t, db, `SELECT webhook_token FROM settings`))
}

func TestMigrate_DatabaseOlderThanTheLaterColumns_StillMigrates(t *testing.T) {
	db, path := openMigrationDB(t)
	mustExec(t, db, `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, credentials_json TEXT NOT NULL DEFAULT '[]', created_at TIMESTAMP NOT NULL)`)
	mustExec(t, db, `INSERT INTO users VALUES ('owner', 'ryan', '[{}]', '2026-01-01 00:00:00')`)
	mustExec(t, db, `CREATE TABLE user_credentials (user_id TEXT PRIMARY KEY, github_token TEXT NOT NULL DEFAULT '', github_username TEXT NOT NULL DEFAULT '', forgejo_url TEXT NOT NULL DEFAULT '', forgejo_token TEXT NOT NULL DEFAULT '', forgejo_username TEXT NOT NULL DEFAULT '', updated_at TIMESTAMP NOT NULL)`)
	mustExec(t, db, `INSERT INTO user_credentials VALUES ('owner', 'sealed-gh', '', '', '', '', '2026-02-02 00:00:00')`)
	mustExec(t, db, `CREATE TABLE ignored_repos (user_id TEXT NOT NULL, forge TEXT NOT NULL, repo_full_name TEXT NOT NULL, PRIMARY KEY (user_id, forge, repo_full_name))`)
	mustExec(t, db, `INSERT INTO ignored_repos VALUES ('owner', 'github', 'a/c')`)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, "sealed-gh", scalar[string](t, db, `SELECT github_token FROM settings`))
	assert.Equal(t, 1, scalar[int](t, db, `SELECT ignore_issues FROM ignored_repos`))
	assert.Equal(t, "{}", scalar[string](t, db, `SELECT filter_state FROM settings`))
}

func backupFiles(t *testing.T, path string) []string {
	t.Helper()
	found, err := filepath.Glob(path + ".before-migration-*")
	require.NoError(t, err)

	return found
}

func TestMigrate_NoUsersTable_WithSettingsToKeep_RefusesInsteadOfDroppingThem(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `DROP TABLE users`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrNoOwner)
	assert.True(t, hasColumn(t, db, "user_credentials", "user_id"), "the old tables must be untouched")
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM user_credentials`))
}

func TestMigrate_EmptyUsersTable_WithSettingsToKeep_RefusesInsteadOfDroppingThem(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `DELETE FROM users`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrNoOwner)
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM ignored_repos`))
}

func TestMigrate_NoUsersAndNothingToKeep_Migrates(t *testing.T) {
	db, path := openMigrationDB(t)
	mustExec(t, db, oldSchema)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.False(t, hasColumn(t, db, "settings", "user_id"))
}

func TestMigrate_RowsKeyedToSomeoneElse_AbortsRatherThanCopyNothing(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `UPDATE user_credentials SET user_id = 'someone-else'`)
	mustExec(t, db, `UPDATE ignored_repos SET user_id = 'someone-else'`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrCopyIncomplete)
	assert.Contains(t, err.Error(), "user_credentials")
	assert.True(t, hasColumn(t, db, "user_credentials", "user_id"), "the whole step rolls back")
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM ignored_repos`))
	assert.False(t, tableExists(t, db, "settings"))
}

func TestMigrate_ARefusedStart_TakesNoBackup(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `INSERT INTO users (id, username, credentials_json, created_at) VALUES ('other', 'sam', '[{}]', '2026-06-01 00:00:00')`)

	for range 3 {
		_, err := migrate(t, db, path)
		require.ErrorIs(t, err, settings.ErrRunPreviousRelease)
	}

	assert.Empty(t, backupFiles(t, path))
	assert.False(t, tableExists(t, db, "schema_version"))
}

func TestMigrate_SeveralUsersNoneWithAPasskey_SaysThePreviousReleaseWillNotHelp(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `UPDATE users SET credentials_json = '[]'`)
	mustExec(t, db, `INSERT INTO users (id, username, credentials_json, created_at) VALUES ('other', 'sam', '[]', '2026-06-01 00:00:00')`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrNoPasskeyHolder)
	require.NotErrorIs(t, err, settings.ErrRunPreviousRelease)
	assert.NotContains(t, err.Error(), "run the previous release")
	assert.Contains(t, err.Error(), "passkey")
	assert.Empty(t, backupFiles(t, path))
}

func TestMigrate_TheOwnerIsTheUserAuthCallsTheOwner(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`)
	mustExec(t, db, `CREATE TABLE single_user_cleanup (ran_at TIMESTAMP NOT NULL, kept_username TEXT NOT NULL, removed_users INTEGER NOT NULL)`)
	// Two rows the owner rule must tell apart: an older one without a passkey
	// and a newer one with. Auth.Owner takes the oldest row either way.
	mustExec(t, db, `DELETE FROM users`)
	mustExec(t, db, `INSERT INTO users (id, username, credentials_json, created_at) VALUES ('b2xk', 'old', '[]', '2025-01-01 00:00:00'), ('bmV3', 'new', '[{}]', '2026-01-01 00:00:00')`)
	for _, table := range []string{"webhook_deliveries", "ignored_repos", "auto_update_branch_repos", "auto_merge_intents", "hidden_pull_requests", "queued_actions", "pull_request_auto_update"} {
		mustExec(t, db, `UPDATE `+table+` SET user_id = 'b2xk'`)
	}
	mustExec(t, db, `UPDATE user_credentials SET user_id = 'bmV3'`)
	mustExec(t, db, `INSERT INTO user_credentials (user_id, webhook_token, updated_at) VALUES ('b2xk', 'old-token', '2026-02-02 00:00:00')`)
	owner, err := auth.NewStore(db).OwnerID(t.Context())
	require.NoError(t, err)

	_, err = migrate(t, db, path)

	require.NoError(t, err)
	want := scalar[string](t, db, `SELECT webhook_token FROM settings`)
	assert.Equal(t, "old-token", want)
	assert.Equal(t, "b2xk", base64.RawURLEncoding.EncodeToString(owner), "the test must really compare the two rules")
}

func TestMigrate_ASettingsTableAlreadyThere_IsReplacedWhenEmpty(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), github_token TEXT NOT NULL DEFAULT '')`)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, "hook-token", scalar[string](t, db, `SELECT webhook_token FROM settings`))
}

func TestMigrate_ASettingsTableAlreadyThereWithRows_RefusesRatherThanOverwrite(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), github_token TEXT NOT NULL DEFAULT '')`)
	mustExec(t, db, `INSERT INTO settings (id, github_token) VALUES (1, 'kept')`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, settings.ErrSettingsTableInTheWay)
	assert.Equal(t, "kept", scalar[string](t, db, `SELECT github_token FROM settings`))
	assert.True(t, hasColumn(t, db, "user_credentials", "user_id"))
	assert.Empty(t, backupFiles(t, path))
}
