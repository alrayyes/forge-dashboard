package api_test

import (
	"io"
	"log/slog"
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/singleuser"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// After the one-time cleanup the kept user's session cookie and API token
// still sign them in.
func TestSingleUserCleanup_KeptUsersSessionAndTokenStillWork(t *testing.T) {
	t.Parallel()
	srv, _, _, _, db, dbPath := newTestServerWithDatabase(t, noSources, false, 0)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv)
	token := createTestAPIToken(t, srv.URL, ownerCookie)

	// A database from before this version has no marker; the owner here
	// registered through the new code, which wrote one.
	_, err := db.ExecContext(t.Context(), `DROP TABLE IF EXISTS single_user_cleanup`)
	require.NoError(t, err)
	_, err = singleuser.Run(t.Context(), db, dbPath, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)

	statuses := map[string]int{}
	for name, do := range map[string]func() *http.Response{
		"kept session": func() *http.Response { return doJSON(t, http.MethodGet, srv.URL+"/api/auth/session", "", ownerCookie) },
		"kept token":   func() *http.Response { return doWithBearer(t, http.MethodGet, srv.URL+"/api/tokens", "", token) },
	} {
		resp := do()
		_ = resp.Body.Close()
		statuses[name] = resp.StatusCode
	}
	assert.Equal(t, map[string]int{
		"kept session": http.StatusOK,
		"kept token":   http.StatusOK,
	}, statuses)
}
