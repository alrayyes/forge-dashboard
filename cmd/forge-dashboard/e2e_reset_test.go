//go:build e2e

package main

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "e2e.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	authStore := auth.NewStore(db)
	require.NoError(t, authStore.Init(ctx))
	cipher, err := settings.NewCipher("MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")
	require.NoError(t, err)
	settingsStore := settings.NewStore(db, cipher)
	require.NoError(t, settingsStore.Init(ctx))

	user, err := authStore.CreateUser(ctx, "owner", "Owner", true)
	require.NoError(t, err)
	require.NoError(t, authStore.AddCredential(ctx, user.ID, webauthn.Credential{ID: []byte{1}}))
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
	for _, table := range []string{"api_tokens", "hidden_pull_requests", "ceremonies", "invites"} {
		assert.Zero(t, rowCount(t, db, table), table)
	}
	assert.Equal(t, 1, rowCount(t, db, "users"), "the first user stays")
	assert.Equal(t, 1, rowCount(t, db, "credential_metadata"), "only the first passkey's label stays")
	kept, err := authStore.GetUserByID(ctx, user.ID)
	require.NoError(t, err)
	assert.Len(t, kept.Credentials, 1, "only the first passkey stays")
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

// A route that wipes the database must never be reachable in a default build.
// The guard for that is in e2e_off_test.go.
