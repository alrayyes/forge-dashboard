package singleuser_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/alrayyes/forge-dashboard/internal/singleuser"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// ownedBy classifies every table that holds a user's rows by the column that
// names the owner. A table added later is in none of these maps, which fails
// TestRun_EveryTableIsClassified until someone decides what a cleanup does
// with it.
var ownedBy = map[string]string{
	"sessions":                 "user_id",
	"api_tokens":               "user_id",
	"credential_metadata":      "user_id",
	"request_log":              "account_id",
	"user_credentials":         "user_id",
	"webhook_deliveries":       "user_id",
	"ignored_repos":            "user_id",
	"auto_update_branch_repos": "user_id",
	"auto_merge_intents":       "user_id",
	"hidden_pull_requests":     "user_id",
	"queued_actions":           "user_id",
	"pull_request_auto_update": "user_id",
}

// seedRow inserts one row owned by the user with this encoded id.
var seedRow = map[string]string{ //nolint:gosec // G101: SQL fixtures, no credentials
	"sessions":                 `INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ('tok-' || ?1, ?1, '2099-01-01', '2026-01-01')`,
	"api_tokens":               `INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES ('id-' || ?1, ?1, 'l', 'hash-' || ?1, '2026-01-01')`,
	"credential_metadata":      `INSERT INTO credential_metadata (user_id, credential_id, label, created_at) VALUES (?1, 'c', 'l', '2026-01-01')`,
	"request_log":              `INSERT INTO request_log (logged_at, forge, account_id, method, endpoint, outcome) VALUES ('2026-01-01', 'github', ?1, 'GET', '/x', 'ok')`,
	"user_credentials":         `INSERT INTO user_credentials (user_id, webhook_token, updated_at) VALUES (?1, 'wh-' || ?1, '2026-01-01')`,
	"webhook_deliveries":       `INSERT INTO webhook_deliveries (user_id, forge, repo_full_name, last_seen_at) VALUES (?1, 'github', 'a/b', '2026-01-01')`,
	"ignored_repos":            `INSERT INTO ignored_repos (user_id, forge, repo_full_name) VALUES (?1, 'github', 'a/b')`,
	"auto_update_branch_repos": `INSERT INTO auto_update_branch_repos (user_id, forge, repo_full_name) VALUES (?1, 'github', 'a/b')`,
	"auto_merge_intents":       `INSERT INTO auto_merge_intents (user_id, forge, repo_full_name, number, armed_at) VALUES (?1, 'github', 'a/b', 1, '2026-01-01')`,
	"hidden_pull_requests":     `INSERT INTO hidden_pull_requests (user_id, forge, repo_full_name, number) VALUES (?1, 'github', 'a/b', 1)`,
	"queued_actions":           `INSERT INTO queued_actions (id, user_id, action, forge, repo_full_name, number, status, run_at, created_at) VALUES ('q-' || ?1, ?1, 'merge', 'github', 'a/b', 1, 'queued', '2026-01-01', '2026-01-01')`,
	"pull_request_auto_update": `INSERT INTO pull_request_auto_update (user_id, forge, repo_full_name, number, enabled) VALUES (?1, 'github', 'a/b', 1, 1)`,
}

type fixture struct {
	db     *sql.DB
	path   string
	auth   *auth.Store
	logbuf *bytes.Buffer
	log    *slog.Logger
	users  []*auth.User // oldest first
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	path := filepath.Join(t.TempDir(), "forge-dashboard.db")
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	ctx := t.Context()
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	cipher, err := settings.NewCipher(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("k"), 32)))
	require.NoError(t, err)
	require.NoError(t, settings.NewStore(db, cipher).Init(ctx))

	buf := &bytes.Buffer{}

	return &fixture{
		db: db, path: path, auth: authStore, logbuf: buf,
		log: slog.New(slog.NewTextHandler(buf, nil)),
	}
}

// addUser registers a user, with a passkey or as an abandoned registration.
func (f *fixture) addUser(t *testing.T, name string, passkey bool) *auth.User {
	t.Helper()
	u, err := f.auth.CreateUser(t.Context(), name, name)
	require.NoError(t, err)
	if passkey {
		require.NoError(t, f.auth.AddCredential(t.Context(), u.ID, webauthn.Credential{ID: []byte("cred-" + name), PublicKey: []byte("pk")}))
	}
	f.users = append(f.users, u)
	time.Sleep(2 * time.Millisecond) // created_at must differ between users

	return u
}

// giveData puts a row in every per-user table for u, plus a ceremony.
func (f *fixture) giveData(t *testing.T, u *auth.User) {
	t.Helper()
	id := base64.RawURLEncoding.EncodeToString(u.ID)
	for table, query := range seedRow {
		_, err := f.db.ExecContext(t.Context(), query, id)
		require.NoError(t, err, table)
	}
	require.NoError(t, f.auth.SaveCeremony(t.Context(), u.Username, "login", webauthn.SessionData{Challenge: "c"}, time.Hour))
}

// threeUsers is the multi-user database the upgrade has to fix: the oldest
// registered user keeps the data, two others own rows everywhere.
func threeUsers(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	for _, name := range []string{"ryan", "sam", "kim"} {
		f.giveData(t, f.addUser(t, name, true))
	}

	return f
}

func (f *fixture) run(t *testing.T) (singleuser.Result, error) {
	t.Helper()

	res, err := singleuser.Run(t.Context(), f.db, f.path, f.log)

	return res, err //nolint:wrapcheck // the test asserts on the error Run itself returns
}

func (f *fixture) count(t *testing.T, query string, args ...any) int {
	t.Helper()
	var n int
	require.NoError(t, f.db.QueryRowContext(t.Context(), query, args...).Scan(&n))

	return n
}

func (f *fixture) tables(t *testing.T) []string {
	t.Helper()
	rows, err := f.db.QueryContext(t.Context(), `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()
	var names []string
	for rows.Next() {
		var n string
		require.NoError(t, rows.Scan(&n))
		names = append(names, n)
	}
	require.NoError(t, rows.Err())

	return names
}

func (f *fixture) markerExists(t *testing.T) bool {
	t.Helper()

	return f.count(t, `SELECT count(*) FROM sqlite_master WHERE name = 'single_user_cleanup'`) == 1
}

func (f *fixture) backups(t *testing.T) []string {
	t.Helper()
	m, err := filepath.Glob(f.path + ".before-single-user-*")
	require.NoError(t, err)

	return m
}

func TestRun_EmptyDatabase_DeletesNothingAndWritesNoMarker(t *testing.T) {
	t.Parallel()
	f := newFixture(t)

	res, err := f.run(t)

	require.NoError(t, err)
	assert.False(t, res.Ran)
	assert.False(t, f.markerExists(t))
	assert.Contains(t, f.logbuf.String(), "nothing to clean up")
}

func TestRun_OnlyAbandonedRegistrations_DeletesNothingAndWritesNoMarker(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	f.addUser(t, "half", false)
	f.addUser(t, "done", false)

	_, err := f.run(t)

	require.NoError(t, err)
	assert.Equal(t, 2, f.count(t, `SELECT count(*) FROM users`))
	assert.False(t, f.markerExists(t))
	assert.Contains(t, f.logbuf.String(), "nothing to clean up")
}

func TestRun_EveryTableIsClassified(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)
	_, err := f.run(t)
	require.NoError(t, err)

	known := map[string]bool{"users": true, "ceremonies": true, "single_user_cleanup": true}
	// The cache tables are keyed by credential and repo and hold no user, so
	// the cleanup has nothing to remove from them.
	for _, table := range []string{"cache_schema", "http_etags", "snapshot_cache", "hook_checks", "webhook_seen"} {
		known[table] = true
	}
	for table := range ownedBy {
		known[table] = true
	}
	for _, table := range f.tables(t) {
		assert.True(t, known[table], "table %q is new: decide what the single-user cleanup does with it, then classify it here and in singleuser", table)
	}
}

func TestRun_ThreeUsers_OnlyTheOldestUsersRowsRemain(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)
	keeper := base64.RawURLEncoding.EncodeToString(f.users[0].ID)

	res, err := f.run(t)

	require.NoError(t, err)
	assert.True(t, res.Ran)
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM users`))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM users WHERE id = ?`, keeper))
	for table, column := range ownedBy {
		assert.Equal(t, 0, f.count(t, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s != ?`, table, column), keeper), "%s holds another user's rows", table)
		assert.Equal(t, 1, f.count(t, fmt.Sprintf(`SELECT count(*) FROM %s WHERE %s = ?`, table, column), keeper), "%s lost the kept user's row", table)
	}
}

func TestRun_ThreeUsers_ClearsTheirCeremonies(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)

	_, err := f.run(t)

	require.NoError(t, err)
	assert.Equal(t, 0, f.count(t, `SELECT count(*) FROM ceremonies WHERE username != 'ryan'`))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM ceremonies WHERE username = 'ryan'`))
}

func TestRun_ThreeUsers_WritesTheMarkerRow(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)

	_, err := f.run(t)

	require.NoError(t, err)
	var kept string
	var removed int
	require.NoError(t, f.db.QueryRowContext(t.Context(), `SELECT kept_username, removed_users FROM single_user_cleanup`).Scan(&kept, &removed))
	assert.Equal(t, "ryan", kept)
	assert.Equal(t, 2, removed)
}

func TestRun_ThreeUsers_LeavesABackupThatStillHoldsAllThreeUsers(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)

	res, err := f.run(t)
	require.NoError(t, err)

	require.Len(t, f.backups(t), 1)
	assert.Equal(t, f.backups(t)[0], res.BackupPath)
	backup, err := sql.Open("sqlite", f.backups(t)[0])
	require.NoError(t, err)
	defer func() { _ = backup.Close() }()
	var n int
	require.NoError(t, backup.QueryRowContext(t.Context(), `SELECT count(*) FROM users`).Scan(&n))
	assert.Equal(t, 3, n)
}

func TestRun_ThreeUsers_BackupIsReadableByTheOwnerOnly(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)

	res, err := f.run(t)
	require.NoError(t, err)

	info, err := os.Stat(res.BackupPath)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o600), info.Mode().Perm())
}

func TestRun_TwoCleanupsInTheSameSecond_BothLeaveTheirOwnBackup(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)
	first, err := f.run(t)
	require.NoError(t, err)
	_, err = f.db.ExecContext(t.Context(), `DROP TABLE single_user_cleanup`)
	require.NoError(t, err)
	f.addUser(t, "al", true)

	second, err := f.run(t)

	require.NoError(t, err)
	assert.NotEqual(t, first.BackupPath, second.BackupPath)
}

func TestRun_ThreeUsers_LogsOneWarningPerRemovedUserAndNoSecrets(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)

	_, err := f.run(t)

	require.NoError(t, err)
	log := f.logbuf.String()
	assert.Equal(t, 2, strings.Count(log, "removed user"))
	assert.Contains(t, log, "username=sam")
	assert.Contains(t, log, "username=kim")
	assert.NotContains(t, log, "hash-")
	assert.NotContains(t, log, "wh-")
}

func TestRun_SecondStart_ChangesNothing(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)
	_, err := f.run(t)
	require.NoError(t, err)
	// A user added between the two starts must survive: the marker says
	// the cleanup already happened.
	f.addUser(t, "late", true)
	f.logbuf.Reset()

	res, err := f.run(t)

	require.NoError(t, err)
	assert.False(t, res.Ran)
	assert.Equal(t, 2, f.count(t, `SELECT count(*) FROM users`))
	assert.Len(t, f.backups(t), 1)
}

func TestRun_OnlyOneRegisteredUser_RecordsTheMarkerWithoutABackup(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	f.giveData(t, f.addUser(t, "ryan", true))

	_, err := f.run(t)

	require.NoError(t, err)
	assert.True(t, f.markerExists(t))
	assert.Empty(t, f.backups(t))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM users`))
}

func TestRun_OldestUserHasNoPasskey_KeepsTheOldestRegisteredOne(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	f.addUser(t, "abandoned", false)
	f.giveData(t, f.addUser(t, "second", true))
	f.giveData(t, f.addUser(t, "third", true))

	_, err := f.run(t)

	require.NoError(t, err)
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM users WHERE username = 'second'`))
	assert.Equal(t, 1, f.count(t, `SELECT count(*) FROM users`))
}

func TestRun_BackupCannotBeWritten_DeletesNothingAndReturnsAnError(t *testing.T) {
	f := threeUsers(t)
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	dir := filepath.Dir(f.path)
	require.NoError(t, os.Chmod(dir, 0o500))       //nolint:gosec // a read-only directory is the point
	t.Cleanup(func() { _ = os.Chmod(dir, 0o700) }) //nolint:gosec // restore so TempDir can clean up

	_, err := f.run(t)

	require.Error(t, err)
	assert.Equal(t, 3, f.count(t, `SELECT count(*) FROM users`))
	assert.False(t, f.markerExists(t))
}

func TestRun_FailureAfterSomeDeletes_RollsBackEveryUser(t *testing.T) {
	t.Parallel()
	f := threeUsers(t)
	_, err := f.db.ExecContext(context.Background(), `CREATE TRIGGER fail_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'injected'); END`)
	require.NoError(t, err)

	_, err = f.run(t)

	require.Error(t, err)
	assert.Equal(t, 3, f.count(t, `SELECT count(*) FROM users`))
	assert.Equal(t, 3, f.count(t, `SELECT count(*) FROM sessions`))
	assert.False(t, f.markerExists(t))
}

func TestRun_KeptUser_StillHasWorkingSessionTokenPasskeysAndSettings(t *testing.T) {
	t.Parallel()
	f := newFixture(t)
	keeper := f.addUser(t, "ryan", true)
	f.addUser(t, "sam", true)
	ctx := t.Context()
	session, err := f.auth.CreateSession(ctx, keeper.ID, time.Hour)
	require.NoError(t, err)
	apiToken, _, err := f.auth.CreateAPIToken(ctx, keeper.ID, "ci", time.Now().Add(time.Hour))
	require.NoError(t, err)
	_, err = f.db.ExecContext(ctx, `INSERT INTO user_credentials (user_id, webhook_token, updated_at) VALUES (?, 'the-hook', '2026-01-01')`, base64.RawURLEncoding.EncodeToString(keeper.ID))
	require.NoError(t, err)

	_, err = f.run(t)
	require.NoError(t, err)

	got, err := f.auth.UserForSession(ctx, session)
	require.NoError(t, err)
	assert.Equal(t, keeper.ID, got.ID)
	got, err = f.auth.UserForAPIToken(ctx, apiToken)
	require.NoError(t, err)
	assert.Equal(t, keeper.ID, got.ID)
	assert.Len(t, got.Credentials, 1)
	cipher, err := settings.NewCipher(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("k"), 32)))
	require.NoError(t, err)
	userID, _, err := settings.NewStore(f.db, cipher).FindByWebhookToken(ctx, "the-hook")
	require.NoError(t, err)
	assert.Equal(t, keeper.ID, userID)
}
