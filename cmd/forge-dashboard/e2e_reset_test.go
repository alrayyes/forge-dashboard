//go:build e2e

package main

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func rowCount(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	require.NoError(t, db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM "+table).Scan(&n)) //nolint:gosec // a table name from the test, not user input

	return n
}

func TestE2EReset_ClearsPerUserStateAndKeepsTheFirstUserAndPasskey(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "e2e.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	cipher, err := settings.NewCipher("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")
	require.NoError(t, err)
	settingsStore := settings.NewStore(db, cipher)
	require.NoError(t, settingsStore.Init(ctx))

	user, err := authStore.CreateUser(ctx, "owner", "Owner")
	require.NoError(t, err)
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{1}, Authenticator: webauthn.Authenticator{SignCount: 5}}))
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{2}}))
	require.NoError(t, authStore.SetCredentialLabel(ctx, user.ID, []byte{1}, "first"))
	require.NoError(t, authStore.SetCredentialLabel(ctx, user.ID, []byte{2}, "second"))
	oldSession, err := authStore.CreateSession(ctx, user.ID, time.Hour)
	require.NoError(t, err)
	_, _, err = authStore.CreateAPIToken(ctx, user.ID, "ci", time.Now().Add(time.Hour))
	require.NoError(t, err)
	require.NoError(t, settingsStore.HidePullRequest(ctx, user.ID, "github", "alrayyes/a", 1, time.Now().Add(time.Hour)))

	deps := api.Deps{AuthStore: authStore, Database: schemaPinger{db: db}, Manager: dashboard.NewManager(time.Minute)}
	srv := httptest.NewServer(withE2EHooks(http.NotFoundHandler(), deps))
	t.Cleanup(srv.Close)

	resp, err := http.Post(srv.URL+"/__e2e/reset", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	for _, table := range []string{"api_tokens", "hidden_pull_requests", "ceremonies"} {
		assert.Zero(t, rowCount(t, db, table), table)
	}
	tables, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	require.NoError(t, err)
	var names []string
	for tables.Next() {
		var name string
		require.NoError(t, tables.Scan(&name))
		names = append(names, name)
	}
	require.NoError(t, tables.Err())
	require.NoError(t, tables.Close())
	for _, name := range names {
		if keptTables[name] {
			continue
		}
		if name == "sessions" {
			assert.Equal(t, 1, rowCount(t, db, name), "only the fresh session")

			continue
		}
		assert.Zero(t, rowCount(t, db, name), "every other table is empty: "+name)
	}
	assert.Equal(t, 1, rowCount(t, db, "users"), "the first user stays")
	assert.Equal(t, 1, rowCount(t, db, "credential_metadata"), "only the first passkey's label stays")
	kept, err := authStore.GetUserByID(ctx, user.ID)
	require.NoError(t, err)
	require.Len(t, kept.Credentials, 1, "only the first passkey stays")
	assert.Zero(t, kept.Credentials[0].Authenticator.SignCount, "its sign counter is back to registration")
	_, err = authStore.UserForSession(ctx, oldSession)
	require.Error(t, err, "the old session is gone")

	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == auth.CookieName {
			cookie = c
		}
	}
	require.NotNil(t, cookie, "the reply signs the caller in with a fresh session")
	signedIn, err := authStore.UserForSession(ctx, cookie.Value)
	require.NoError(t, err)
	assert.Equal(t, "owner", signedIn.Username)
}

func TestE2EReset_ForgetsTheTabsThePreviousTestLeftReportingVisible(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "e2e.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	cipher, err := settings.NewCipher("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")
	require.NoError(t, err)
	require.NoError(t, settings.NewStore(db, cipher).Init(ctx))
	user, err := authStore.CreateUser(ctx, "owner", "Owner")
	require.NoError(t, err)
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{1}}))

	manager := dashboard.NewManager(time.Minute)
	activity := dashboard.NewActivity(time.Minute, nil)
	manager.SetActivity(activity)
	activity.Present("left-open-tab", true)
	require.Equal(t, 1, activity.ViewerCount())

	deps := api.Deps{AuthStore: authStore, Database: schemaPinger{db: db}, Manager: manager}
	srv := httptest.NewServer(withE2EHooks(http.NotFoundHandler(), deps))
	t.Cleanup(srv.Close)

	resp, err := http.Post(srv.URL+"/__e2e/reset", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.Zero(t, activity.ViewerCount())
}

// A reset that arrives while the server is writing waits for the write to end
// instead of failing. The reset's transaction used to start with a read and
// only then ask for the write lock; when another writer committed in between,
// SQLite refused the upgrade at once (SQLITE_BUSY_SNAPSHOT) without waiting out
// the busy timeout: https://www.sqlite.org/wal.html#sometimes_queries_return_sqlite_busy_in_wal_mode
func TestE2EReset_WaitsForAConcurrentWriteInsteadOfFailing(t *testing.T) {
	ctx := t.Context()
	dsn := dbdsn.For(filepath.Join(t.TempDir(), "e2e.db"))
	db, err := sql.Open("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	cipher, err := settings.NewCipher("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")
	require.NoError(t, err)
	require.NoError(t, settings.NewStore(db, cipher).Init(ctx))
	user, err := authStore.CreateUser(ctx, "owner", "Owner")
	require.NoError(t, err)
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{1}}))

	// The server's own poll or webhook: its own connection holds the write
	// lock for a moment, then commits.
	writer, err := sql.Open("sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { _ = writer.Close() })
	conn, err := writer.Conn(ctx)
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE")
	require.NoError(t, err)
	_, err = conn.ExecContext(ctx, "INSERT INTO hidden_pull_requests (user_id, forge, repo_full_name, number) VALUES ('x', 'github', 'a/b', 1)")
	require.NoError(t, err)
	committed := make(chan error, 1)
	go func() {
		time.Sleep(300 * time.Millisecond)
		_, commitErr := conn.ExecContext(context.Background(), "COMMIT")
		_ = conn.Close()
		committed <- commitErr
	}()

	deps := api.Deps{AuthStore: authStore, Database: schemaPinger{db: db}, Manager: dashboard.NewManager(time.Minute)}
	srv := httptest.NewServer(withE2EHooks(http.NotFoundHandler(), deps))
	t.Cleanup(srv.Close)

	resp, err := http.Post(srv.URL+"/__e2e/reset", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.NoError(t, <-committed)
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Zero(t, rowCount(t, db, "hidden_pull_requests"), "the row the other writer committed is emptied")
	assert.Equal(t, 1, rowCount(t, db, "users"), "the owner stays")
}

// A reset that fails midway rolls back and leaves no open transaction on the
// connection it hands back to the pool. With one connection the next caller is
// guaranteed to get the same one, and BEGIN IMMEDIATE on a connection still
// inside a transaction fails.
func TestE2EReset_AFailedRewriteLeavesNoOpenTransaction(t *testing.T) {
	ctx := t.Context()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "e2e.db")))
	require.NoError(t, err)
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	user, err := authStore.CreateUser(ctx, "owner", "Owner")
	require.NoError(t, err)
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{1}}))
	owner, err := authStore.GetUserByID(ctx, user.ID)
	require.NoError(t, err)
	_, err = db.ExecContext(ctx, "DROP TABLE credential_metadata") // keepOwner's last statement now fails

	require.NoError(t, err)
	require.Error(t, rewriteDatabase(ctx, db, owner, owner.Credentials[:1]))

	conn, err := db.Conn(ctx)
	require.NoError(t, err)
	t.Cleanup(func() { _ = conn.Close() })
	_, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE")
	assert.NoError(t, err, "the connection is not inside the failed transaction")
}

// A route that wipes the database must never be reachable in a default build.
// The guard for that is in e2e_off_test.go.
