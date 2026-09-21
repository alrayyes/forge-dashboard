package main

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestAuthStore(t *testing.T) *auth.Store {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "auth.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	store := auth.NewStore(db)
	require.NoError(t, store.Init(t.Context()))

	return store
}

// TestBuildSourcesForUser_TwoUsers_RecordUnderTwoDistinctAccountIDs is
// task 2.5's own acceptance criterion: each account's forge clients
// have to record under that account's own ID, not a shared or empty
// one, since correlating a shared-credential problem (#435's suspected
// cause) is the entire reason #482 exists. Forgejo, not GitHub, because
// its instanceURL is configurable per-user (settings.Credentials.
// ForgejoURL) — this is what lets the test point real clients at an
// httptest server and observe a genuine recorded request, rather than
// only inspecting how the client was constructed.
func TestBuildSourcesForUser_TwoUsers_RecordUnderTwoDistinctAccountIDs(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	store := newTestAuthStore(t)
	build := buildSourcesForUser(store)

	userA, err := store.CreateUser(t.Context(), "user-a", "User A", false)
	require.NoError(t, err)
	userB, err := store.CreateUser(t.Context(), "user-b", "User B", false)
	require.NoError(t, err)

	creds := settings.Credentials{ForgejoURL: srv.URL, ForgejoToken: "test-token"}

	sourcesA := build(userA.ID, creds)
	sourcesB := build(userB.ID, creds)
	require.Len(t, sourcesA, 1)
	require.Len(t, sourcesB, 1)

	sourcesA[0].Fetch(t.Context())
	sourcesB[0].Fetch(t.Context())

	rows, err := store.ListRequests(t.Context(), auth.RequestLogFilter{})
	require.NoError(t, err)
	require.Len(t, rows, 2)

	accountA := base64.RawURLEncoding.EncodeToString(userA.ID)
	accountB := base64.RawURLEncoding.EncodeToString(userB.ID)
	gotAccounts := []string{rows[0].AccountID, rows[1].AccountID}
	assert.ElementsMatch(t, []string{accountA, accountB}, gotAccounts)
	assert.NotEqual(t, accountA, accountB)
}
