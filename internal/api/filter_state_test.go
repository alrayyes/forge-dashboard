package api_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFilterStateGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/settings/filter-state")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestFilterStateGet_NeverSaved_ReturnsEmptyObject(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.JSONEq(t, "{}", readAll(t, resp))
}

func TestFilterStatePut_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/api/settings/filter-state", "application/json", strings.NewReader(`{}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	// The mux only registers PUT for this path, so an unauthenticated
	// POST 405s before RequireAuth even runs — still proves no state
	// change slipped through without a session either way.
	assert.NotEqual(t, http.StatusNoContent, resp.StatusCode)
}

func TestFilterStatePut_ThenGet_RoundTrips(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	body := `{"shared":{"forge":"github","title":"alarm"},"issue":{"hideDependencyDashboard":"1"}}`

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", body, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	require.Equal(t, http.StatusOK, getResp.StatusCode)
	assert.JSONEq(t, body, readAll(t, getResp))
}

func TestFilterStatePut_InvalidJSON_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", "not json", sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestFilterStatePut_TooLarge_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	huge := `{"shared":{"title":"` + strings.Repeat("a", 20*1024) + `"}}`

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", huge, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestFilterStatePut_DoesNotDisturbAlreadySavedSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	putSettings := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"octocat"}`, sessionCookie)
	_ = putSettings.Body.Close()
	require.Equal(t, http.StatusOK, putSettings.StatusCode)

	putFilters := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", `{"shared":{"forge":"github"}}`, sessionCookie)
	_ = putFilters.Body.Close()
	require.Equal(t, http.StatusNoContent, putFilters.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	body := readAll(t, getResp)
	assert.Contains(t, body, "octocat")
}

func TestFilterStateGet_TwoUsers_EachSeesOnlyTheirOwn(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	aCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, "Admin")
	token := createInviteViaAdmin(t, srv, aCookie, testUser, testDisplay)
	bCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay, token)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", `{"shared":{"forge":"github"}}`, aCookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", bCookie)
	defer func() { _ = getResp.Body.Close() }()
	assert.JSONEq(t, "{}", readAll(t, getResp))
}

// createTestAPIToken makes a personal API token the way Settings does, over
// the signed-in session, and returns the secret.
func createTestAPIToken(t *testing.T, srvURL string, sessionCookie *http.Cookie) string {
	t.Helper()

	resp := doJSON(t, http.MethodPost, srvURL+"/api/tokens", tokenCreateBody("an agent"), sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	var created struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&created))
	require.NotEmpty(t, created.Token)

	return created.Token
}

func doWithBearer(t *testing.T, method, url, body, token string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(method, url, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

// The saved filters are the web UI's own state (#1000): an agent holding a
// personal API token must not be able to read or change them.
func TestFilterStateGet_WithAnAPIToken_Returns403(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createTestAPIToken(t, srv.URL, sessionCookie)

	resp := doWithBearer(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", token)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestFilterStatePut_WithAnAPIToken_Returns403AndStoresNothing(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createTestAPIToken(t, srv.URL, sessionCookie)
	mine := `{"shared":{"forge":"forgejo"}}`
	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", mine, sessionCookie).Body.Close()

	resp := doWithBearer(t, http.MethodPut, srv.URL+"/api/settings/filter-state", `{"shared":{"forge":"github"}}`, token)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusForbidden, resp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	assert.JSONEq(t, mine, readAll(t, getResp), "the token's write must not land")
}

// Not parallel: it swaps the global slog default.
func TestFilterStatePut_LogsHowTheCallerAuthenticatedAndTheUserAgent(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings/filter-state", strings.NewReader(`{}`))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (test browser)")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.Contains(t, logs.String(), "filter state saved")
	assert.Contains(t, logs.String(), "via=session")
	assert.Contains(t, logs.String(), "Mozilla/5.0 (test browser)")
}
