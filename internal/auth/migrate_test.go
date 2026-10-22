package auth_test

import (
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/dbmigrate"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

//go:embed testdata/old_schema.sql
var oldSchema string

//go:embed testdata/old_rows.sql
var oldRows string

var quietLog = slog.New(slog.NewTextHandler(io.Discard, nil))

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

	return migrateLogged(t, db, path, quietLog)
}

func migrateLogged(t *testing.T, db *sql.DB, path string, log *slog.Logger) (dbmigrate.Result, error) {
	t.Helper()

	return dbmigrate.Run(t.Context(), db, path, auth.MigrationSteps(log), log) //nolint:wrapcheck // test helper
}

func hasColumn(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()

	return scalar[int](t, db, `SELECT count(*) FROM pragma_table_info(?) WHERE name = ?`, table, column) > 0
}

func tableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()

	return scalar[int](t, db, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table) > 0
}

func backupFiles(t *testing.T, path string) []string {
	t.Helper()
	found, err := filepath.Glob(path + ".before-migration-*")
	require.NoError(t, err)

	return found
}

func addCleanupMarker(t *testing.T, db *sql.DB) {
	t.Helper()
	mustExec(t, db, `CREATE TABLE single_user_cleanup (ran_at TIMESTAMP NOT NULL, kept_username TEXT NOT NULL, removed_users INTEGER NOT NULL)`)
	mustExec(t, db, `INSERT INTO single_user_cleanup VALUES ('2026-07-01 00:00:00', 'ryan', 1)`)
}

func TestMigrate_OldShape_KeepsEveryRowWithoutTheUserID(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 1, res.Applied)
	assert.NotEmpty(t, res.BackupPath)
	for _, table := range []string{"sessions", "api_tokens", "credential_metadata"} {
		assert.False(t, hasColumn(t, db, table, "user_id"), table)
	}
	assert.False(t, hasColumn(t, db, "request_log", "account_id"))
	assert.True(t, hasColumn(t, db, "users", "id"), "users.id is the passkey handle and stays")

	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM sessions WHERE token = 'session-cookie'`))
	assert.Equal(t, "hash-one", scalar[string](t, db, `SELECT token_hash FROM api_tokens WHERE id = 't1'`))
	assert.Equal(t, "hash-two", scalar[string](t, db, `SELECT token_hash FROM api_tokens WHERE id = 't2'`))
	assert.Equal(t, "mcp", scalar[string](t, db, `SELECT label FROM api_tokens WHERE id = 't2'`))
	assert.True(t, scalar[sql.NullTime](t, db, `SELECT last_used_at FROM api_tokens WHERE id = 't1'`).Valid)
	assert.Equal(t, "Phone", scalar[string](t, db, `SELECT label FROM credential_metadata WHERE credential_id = 'cred-b'`))
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM request_log`))
	assert.Equal(t, "/api/v1/version", scalar[string](t, db, `SELECT endpoint FROM request_log WHERE id = 2`))
	assert.Equal(t, 5000, scalar[int](t, db, `SELECT rate_limit_limit FROM request_log WHERE id = 1`))
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM ceremonies`), "ceremonies stay keyed by username")
	assert.Equal(t, "b3duZXI", scalar[string](t, db, `SELECT id FROM users`))
}

func TestMigrate_RunTwice_SecondRunChangesNothing(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrate(t, db, path)
	require.NoError(t, err)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, res.Applied)
	assert.Empty(t, res.BackupPath)
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM api_tokens`))
}

func TestMigrate_StepRerunOnNewShape_IsANoOp(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	_, err := migrate(t, db, path)
	require.NoError(t, err)
	mustExec(t, db, `UPDATE schema_version SET version = 0`)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 1, res.Applied)
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM api_tokens`))
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM request_log`))
}

func TestMigrate_FailureMidStep_LeavesEveryOldTableIntact(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	// The step renames each old table aside; a squatter on that name makes it
	// fail after the tables before it were already rebuilt.
	mustExec(t, db, `CREATE TABLE request_log_old (x TEXT)`)

	_, err := migrate(t, db, path)

	require.Error(t, err)
	for _, table := range []string{"sessions", "api_tokens", "credential_metadata"} {
		assert.True(t, hasColumn(t, db, table, "user_id"), table)
		assert.Positive(t, scalar[int](t, db, `SELECT count(*) FROM `+table), table)
	}
	assert.True(t, hasColumn(t, db, "request_log", "account_id"))
	assert.False(t, tableExists(t, db, "schema_version"), "a failed step writes no version")
}

func TestMigrate_FreshDatabase_CreatesNothing(t *testing.T) {
	db, path := openMigrationDB(t)

	res, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Zero(t, res.Applied)
	assert.Zero(t, scalar[int](t, db, `SELECT count(*) FROM sqlite_master WHERE name != 'schema_version'`))
}

func TestMigrate_SeveralUsersAndNoCleanupMarker_RefusesWithoutABackup(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('other', 'sam', 'Sam', '[{}]', '2026-06-01 00:00:00')`)

	for range 3 {
		_, err := migrate(t, db, path)
		require.ErrorIs(t, err, auth.ErrSeveralUsers)
	}

	assert.Empty(t, backupFiles(t, path))
	assert.True(t, hasColumn(t, db, "sessions", "user_id"))
	assert.False(t, tableExists(t, db, "schema_version"))
}

func TestMigrate_SeveralUsersNoneWithAPasskeyAndNoMarker_KeepsTheOldestAndWarns(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `UPDATE users SET credentials_json = '[]'`)
	mustExec(t, db, `INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('other', 'sam', 'Sam', '[]', '2026-06-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO sessions VALUES ('other-session', 'other', '2099-01-01 00:00:00', '2026-02-01 00:00:00')`)

	var logs strings.Builder
	_, err := migrateLogged(t, db, path, slog.New(slog.NewTextHandler(&logs, nil)))

	require.NoError(t, err, "the previous release writes no marker here, so waiting for it never ends")
	assert.False(t, hasColumn(t, db, "sessions", "user_id"))
	assert.Contains(t, logs.String(), "user_id=other")
	assert.NotEmpty(t, backupFiles(t, path))
}

func TestMigrate_SeveralUsersButCleanupMarker_KeepsTheOwnersRowsAndWarnsAboutTheRest(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	addCleanupMarker(t, db)
	mustExec(t, db, `INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('other', 'sam', 'Sam', '[{}]', '2026-06-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO sessions VALUES ('other-session', 'other', '2099-01-01 00:00:00', '2026-02-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES ('t3', 'other', 'x', 'hash-three', '2026-02-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO credential_metadata VALUES ('other', 'cred-z', 'Key', '2026-01-01 00:00:00')`)

	var logs strings.Builder
	_, err := migrateLogged(t, db, path, slog.New(slog.NewTextHandler(&logs, nil)))

	require.NoError(t, err)
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM sessions`))
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM api_tokens`))
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM credential_metadata`))
	assert.Contains(t, logs.String(), "level=WARN")
	for _, want := range []string{"table=sessions", "table=api_tokens", "table=credential_metadata", "user_id=other", "backup"} {
		assert.Contains(t, logs.String(), want)
	}
	assert.NotContains(t, logs.String(), "other-session", "a session token is a secret")
	assert.NotContains(t, logs.String(), "hash-three")
}

func TestMigrate_RowsOfAUnknownUser_AreDroppedWithAWarning(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `PRAGMA foreign_keys = OFF`)
	mustExec(t, db, `INSERT INTO sessions VALUES ('ghost-session', 'ghost', '2099-01-01 00:00:00', '2026-02-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO credential_metadata VALUES ('ghost', 'cred-g', 'Key', '2026-01-01 00:00:00')`)
	before := scalar[int](t, db, `SELECT count(*) FROM sessions WHERE user_id != 'ghost'`)

	var logs strings.Builder
	_, err := migrateLogged(t, db, path, slog.New(slog.NewTextHandler(&logs, nil)))

	require.NoError(t, err, "the old cleanup removed such rows silently, so they must not stop the start")
	assert.Equal(t, before, scalar[int](t, db, `SELECT count(*) FROM sessions`))
	assert.False(t, hasColumn(t, db, "sessions", "user_id"))
	assert.Contains(t, logs.String(), "level=WARN")
	assert.Contains(t, logs.String(), "user_id=ghost")
	assert.NotContains(t, logs.String(), "ghost-session", "a session token is a secret")
	assert.NotEmpty(t, backupFiles(t, path))
}

func TestMigrate_NoUsersButRowsToKeep_RefusesInsteadOfDroppingThem(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `DELETE FROM users`)

	_, err := migrate(t, db, path)

	require.ErrorIs(t, err, auth.ErrNoOwner)
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM api_tokens`))
	assert.Empty(t, backupFiles(t, path))
}

func TestMigrate_NoUsersAndNothingToKeep_Migrates(t *testing.T) {
	db, path := openMigrationDB(t)
	mustExec(t, db, oldSchema)
	mustExec(t, db, `INSERT INTO request_log (logged_at, forge, method, endpoint, outcome) VALUES ('2026-04-01 00:00:00', 'github', 'GET', '/user', 'success')`)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.False(t, hasColumn(t, db, "sessions", "user_id"))
	assert.Equal(t, 1, scalar[int](t, db, `SELECT count(*) FROM request_log`), "the request log is the instance's, not a user's")
}

func TestMigrate_APITokensFromBeforeExpiry_StillMigrate(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	mustExec(t, db, `ALTER TABLE api_tokens DROP COLUMN expires_at`)

	_, err := migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, 2, scalar[int](t, db, `SELECT count(*) FROM api_tokens`))
	assert.True(t, hasColumn(t, db, "api_tokens", "expires_at"))
}

func TestMigrate_TheOwnerIsTheUserTheStoreCallsTheOwner(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	addCleanupMarker(t, db)
	// An older user without a passkey and a newer one with: Owner takes the oldest row.
	mustExec(t, db, `UPDATE users SET id = 'new', username = 'new', created_at = '2026-01-01 00:00:00'`)
	mustExec(t, db, `UPDATE sessions SET user_id = 'new'`)
	mustExec(t, db, `UPDATE api_tokens SET user_id = 'new'`)
	mustExec(t, db, `UPDATE credential_metadata SET user_id = 'new'`)
	mustExec(t, db, `INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES ('old', 'old', 'Old', '[]', '2025-01-01 00:00:00')`)
	mustExec(t, db, `INSERT INTO sessions VALUES ('old-session', 'old', '2099-01-01 00:00:00', '2026-02-01 00:00:00')`)
	owner, err := auth.NewStore(db).Owner(t.Context())
	require.NoError(t, err)
	require.Equal(t, "old", owner.Username, "the test must really compare the two rules")

	_, err = migrate(t, db, path)

	require.NoError(t, err)
	assert.Equal(t, "old-session", scalar[string](t, db, `SELECT token FROM sessions`))
}

func TestMigrate_AfterwardsTheStoreAuthenticatesTheSameSessionAndBothTokens(t *testing.T) {
	db, path := openMigrationDB(t)
	seedOldShape(t, db)
	// Real hashes and real passkey ids, so the store can find them again.
	sum := func(raw string) string {
		h := sha256.Sum256([]byte(raw))

		return hex.EncodeToString(h[:])
	}
	mustExec(t, db, `UPDATE api_tokens SET token_hash = '`+sum("raw-one")+`' WHERE id = 't1'`)
	mustExec(t, db, `UPDATE api_tokens SET token_hash = '`+sum("raw-two")+`' WHERE id = 't2'`)
	idA, idB := []byte("cred-a"), []byte("cred-b")
	mustExec(t, db, `UPDATE credential_metadata SET credential_id = '`+base64.RawURLEncoding.EncodeToString(idA)+`' WHERE credential_id = 'cred-a'`)
	mustExec(t, db, `UPDATE credential_metadata SET credential_id = '`+base64.RawURLEncoding.EncodeToString(idB)+`' WHERE credential_id = 'cred-b'`)
	creds, err := json.Marshal([]webauthn.Credential{{ID: idA, PublicKey: []byte("pk")}, {ID: idB, PublicKey: []byte("pk")}})
	require.NoError(t, err)
	mustExec(t, db, `UPDATE users SET credentials_json = '`+string(creds)+`'`)

	_, err = migrate(t, db, path)
	require.NoError(t, err)

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))
	for name, got := range map[string]func() (*auth.User, error){
		"the session cookie": func() (*auth.User, error) { return store.UserForSession(t.Context(), "session-cookie") },
		"the first token":    func() (*auth.User, error) { return store.UserForAPIToken(t.Context(), "raw-one") },
		"the second token":   func() (*auth.User, error) { return store.UserForAPIToken(t.Context(), "raw-two") },
	} {
		user, err := got()
		require.NoError(t, err, name)
		assert.Equal(t, []byte("owner"), user.ID, name+" still signs the owner in, and the passkey handle is unchanged")
	}

	tokens, err := store.ListAPITokens(t.Context())
	require.NoError(t, err)
	assert.Len(t, tokens, 2)
	labels, err := store.ListCredentials(t.Context())
	require.NoError(t, err)
	require.Len(t, labels, 2)
	assert.Equal(t, "Laptop", labels[0].Label)
	assert.Equal(t, "Phone", labels[1].Label)
}
