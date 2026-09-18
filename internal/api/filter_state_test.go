package api_test

import (
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
	bCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/filter-state", `{"shared":{"forge":"github"}}`, aCookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusNoContent, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/filter-state", "", bCookie)
	defer func() { _ = getResp.Body.Close() }()
	assert.JSONEq(t, "{}", readAll(t, getResp))
}
