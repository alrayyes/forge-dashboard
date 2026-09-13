package api_test

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func doJSON(t *testing.T, method, url, body string, cookie *http.Cookie) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp
}

func TestSettingsGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/settings")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSettingsGet_NothingSavedYet_ReturnsAllUnset(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.SettingsResponse
	require.NoError(t, readJSON(resp, &got))
	assert.False(t, got.GitHubTokenSet)
	assert.False(t, got.ForgejoTokenSet)
	assert.Empty(t, got.GitHubUsername)
}

func TestSettingsPut_ThenGet_RoundTripsNonSecretFieldsAndNeverReturnsTheToken(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings",
		`{"githubToken":"ghp_secret","githubUsername":"ryan","forgejoUrl":"https://git.example.com","forgejoToken":"fj_secret","forgejoUsername":"ryan"}`,
		sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	body, err := io.ReadAll(putResp.Body)
	require.NoError(t, err)
	assert.NotContains(t, string(body), "ghp_secret", "the response to a settings save must never echo the token back")
	assert.NotContains(t, string(body), "fj_secret")

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()

	var got api.SettingsResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.True(t, got.GitHubTokenSet)
	assert.Equal(t, "ryan", got.GitHubUsername)
	assert.Equal(t, "https://git.example.com", got.ForgejoURL)
	assert.True(t, got.ForgejoTokenSet)
}

func TestSettingsPut_ForgejoTokenWithoutURL_Rejected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"forgejoToken":"fj_secret"}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestSettingsPut_ForgejoUsernameWithoutURL_Rejected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"forgejoUsername":"ryan"}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestSettingsPut_ForgejoURLAlongsideTokenOrUsername_Accepted(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings",
		`{"forgejoUrl":"https://git.example.com","forgejoUsername":"ryan"}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestSettingsPut_ClearingForgejoURLWhileATokenIsAlreadySaved_Rejected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	first := doJSON(t, http.MethodPut, srv.URL+"/api/settings",
		`{"forgejoUrl":"https://git.example.com","forgejoToken":"fj_secret"}`, sessionCookie)
	_ = first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode)

	// The token field is blank here too, but that means "keep the saved
	// token" (see settingsPutRequest's doc comment) — so this still leaves
	// a Forgejo token on file with no URL to use it against, and should be
	// refused the same as never having set a URL at all.
	second := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"forgejoUrl":""}`, sessionCookie)
	defer func() { _ = second.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, second.StatusCode)
}

func TestSettingsPut_BlankTokenField_KeepsThePreviouslySavedToken(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	first := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"ghp_original","githubUsername":"ryan"}`, sessionCookie)
	_ = first.Body.Close()
	require.Equal(t, http.StatusOK, first.StatusCode)

	// A second save that only changes the username, with the token field
	// left blank — the real Settings page never re-sends a token it
	// can't show the user in the first place.
	second := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"ryan-renamed"}`, sessionCookie)
	defer func() { _ = second.Body.Close() }()
	require.Equal(t, http.StatusOK, second.StatusCode)

	var got api.SettingsResponse
	require.NoError(t, readJSON(second, &got))
	assert.True(t, got.GitHubTokenSet, "the token saved in the first request should survive a second request that didn't resend it")
	assert.Equal(t, "ryan-renamed", got.GitHubUsername)
}
