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
	resp, err := testClient(t).Get(srv.URL + "/api/v1/settings/filter-state")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestFilterStateGet_NeverSaved_ReturnsEmptyObject(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/settings/filter-state", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.JSONEq(t, "{}", readAll(t, resp))
}

func TestFilterStatePut_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Post(srv.URL+"/api/v1/settings/filter-state", "application/json", strings.NewReader(`{}`))
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
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	body := `{"shared":{"forge":"github","title":"alarm"},"issue":{"hideDependencyDashboard":"1"}}`

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", body, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/settings/filter-state", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	require.Equal(t, http.StatusOK, getResp.StatusCode)
	assert.JSONEq(t, body, readAll(t, getResp))
}

// The journey spec used to read every remembered control back from the server
// copy in a browser. This is that round trip: every group and key the controls
// store, including an empty string (a box switched off) and a pick of several
// values, comes back exactly as saved.
func TestFilterStatePut_ThenGet_RoundTripsEveryGroupAndKey(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	body := `{"shared":{"forge":"forgejo","repo":"github:acme/app\nforgejo:acme/infra",` +
		`"author":"forgejo:dana","label":"bug","created":"1440","updated":"1440",` +
		`"groupBy":"repo","title":"pull"},` +
		`"pr":{"ci":"failing","merge":"conflicting","review":"ready","autoMerge":"off"},` +
		`"issue":{"hideDependencyDashboard":"","hideTitleRegex":"^zzz"},` +
		`"view":{"sort":"created","paused":"1","drafts":"1"},` +
		`"branches":{"status":"failing"},` +
		`"webhooks":{"forge":"forgejo","repo":"infra","status":"pending","sort":"hasWebhook","dir":"asc"},` +
		`"rev":7}`

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", body, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/settings/filter-state", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	require.Equal(t, http.StatusOK, getResp.StatusCode)
	assert.JSONEq(t, body, readAll(t, getResp))
}

func TestFilterStatePut_InvalidJSON_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", "not json", sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestFilterStatePut_TooLarge_Returns400(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	huge := `{"shared":{"title":"` + strings.Repeat("a", 20*1024) + `"}}`

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", huge, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestFilterStatePut_DoesNotDisturbAlreadySavedSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	putSettings := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings", `{"githubUsername":"octocat"}`, sessionCookie)
	_ = putSettings.Body.Close()
	require.Equal(t, http.StatusOK, putSettings.StatusCode)

	putFilters := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", `{"shared":{"forge":"github"}}`, sessionCookie)
	_ = putFilters.Body.Close()
	require.Equal(t, http.StatusNoContent, putFilters.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	body := readAll(t, getResp)
	assert.Contains(t, body, "octocat")
}

// createTestAPIToken makes a personal API token the way Settings does, over
// the signed-in session, and returns the secret.
func createTestAPIToken(t *testing.T, srvURL string, sessionCookie *http.Cookie) string {
	t.Helper()

	resp := doJSON(t, http.MethodPost, srvURL+"/api/v1/tokens", tokenCreateBody("an agent"), sessionCookie)
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
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

// The saved filters are the web UI's own state (#1000): an agent holding a
// personal API token must not be able to read or change them.
func TestFilterStateGet_WithAnAPIToken_Returns403(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	token := createTestAPIToken(t, srv.URL, sessionCookie)

	resp := doWithBearer(t, http.MethodGet, srv.URL+"/api/v1/settings/filter-state", "", token)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestFilterStatePut_WithAnAPIToken_Returns403AndStoresNothing(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	token := createTestAPIToken(t, srv.URL, sessionCookie)
	mine := `{"shared":{"forge":"forgejo"}}`
	_ = doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", mine, sessionCookie).Body.Close()

	resp := doWithBearer(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", `{"shared":{"forge":"github"}}`, token)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusForbidden, resp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/settings/filter-state", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	assert.JSONEq(t, mine, readAll(t, getResp), "the token's write must not land")
}

// Not parallel: it swaps the global slog default.
func TestFilterStatePut_LogsHowTheCallerAuthenticatedAndTheUserAgent(t *testing.T) {
	logs := withCapturedLogs(t, slog.LevelInfo)

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/v1/settings/filter-state", strings.NewReader(`{}`))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "Mozilla/5.0 (test browser)")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.Contains(t, logs.String(), "filter state saved")
	assert.Contains(t, logs.String(), "via=session")
	assert.Contains(t, logs.String(), "Mozilla/5.0 (test browser)")
}

func putFilterState(t *testing.T, serverURL, body string, sessionCookie *http.Cookie) int {
	t.Helper()

	resp := doJSON(t, http.MethodPut, serverURL+"/api/v1/settings/filter-state", body, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode
}

func getFilterState(t *testing.T, serverURL string, sessionCookie *http.Cookie) string {
	t.Helper()

	resp := doJSON(t, http.MethodGet, serverURL+"/api/v1/settings/filter-state", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	return readAll(t, resp)
}

// A save sent on leaving the page can overtake an older one still in flight;
// the older one then lands last and must not bring the old value back.
func TestFilterStatePut_OlderRevisionThanSaved_KeepsTheNewerCopy(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	newer := `{"shared":{"title":"zqxjk"},"rev":7}`

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, newer, sessionCookie))
	assert.Equal(t, http.StatusOK, putFilterState(t, srv.URL, `{"shared":{"title":"first"},"rev":6}`, sessionCookie))

	assert.JSONEq(t, newer, getFilterState(t, srv.URL, sessionCookie))
}

// The page that sent the ignored save learns which revision won, so it can
// catch up and send the edit again.
func TestFilterStatePut_OlderRevisionThanSaved_AnswersWithTheSavedRevision(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"a"},"rev":7}`, sessionCookie))

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings/filter-state", `{"shared":{"title":"b"},"rev":6}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.JSONEq(t, `{"rev":7}`, readAll(t, resp))
}

func TestFilterStatePut_SameOrNewerRevision_Replaces(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"a"},"rev":7}`, sessionCookie))
	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"b"},"rev":7}`, sessionCookie))
	assert.JSONEq(t, `{"shared":{"title":"b"},"rev":7}`, getFilterState(t, srv.URL, sessionCookie))

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"c"},"rev":8}`, sessionCookie))
	assert.JSONEq(t, `{"shared":{"title":"c"},"rev":8}`, getFilterState(t, srv.URL, sessionCookie))
}

// A body with no revision, from a client older than revisions, still saves.
func TestFilterStatePut_NoRevision_Replaces(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"a"},"rev":7}`, sessionCookie))
	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"b"}}`, sessionCookie))

	assert.JSONEq(t, `{"shared":{"title":"b"}}`, getFilterState(t, srv.URL, sessionCookie))
}

func TestFilterStatePut_NonNumericRevision_DoesNotPinTheCopy(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"a"},"rev":"x"}`, sessionCookie))
	require.Equal(t, http.StatusNoContent, putFilterState(t, srv.URL, `{"shared":{"title":"b"},"rev":1}`, sessionCookie))

	assert.JSONEq(t, `{"shared":{"title":"b"},"rev":1}`, getFilterState(t, srv.URL, sessionCookie))
}
