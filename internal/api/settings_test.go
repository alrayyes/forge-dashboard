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

func TestThemeGet_NothingSavedYet_ReturnsEmptyMeaningSystem(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/theme", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.ThemeResponse
	require.NoError(t, readJSON(resp, &got))
	assert.Empty(t, got.Theme)
}

// This endpoint exists specifically so a page that only needs the theme
// doesn't also provision webhook credentials as a side effect.
func TestThemeGet_DoesNotProvisionWebhookCredentialsOrAffectDashboardStream(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/theme", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	streamReq, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	streamReq.AddCookie(sessionCookie)
	streamResp, err := http.DefaultClient.Do(streamReq)
	require.NoError(t, err)
	defer func() { _ = streamResp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, streamResp.StatusCode)
}

// Theme has its own dedicated PUT /api/settings/theme (handleThemePut) —
// the main settings PUT doesn't accept it at all, so a plain settings
// save can't reset it back to "" the way it would if Theme were just
// another field in settingsPutRequest with no explicit carry-over.
func TestSettingsPut_DoesNotAcceptOrDisturbTheme(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"dark"}`, sessionCookie).Body.Close()

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"ryan","theme":"light"}`, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var got api.SettingsResponse
	require.NoError(t, readJSON(putResp, &got))
	assert.Equal(t, "dark", got.Theme, "the main settings PUT must not be able to change theme")
}

func TestThemePut_ThenGet_RoundTrips(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"dark"}`, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var putBody api.ThemeResponse
	require.NoError(t, readJSON(putResp, &putBody))
	assert.Equal(t, "dark", putBody.Theme)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/theme", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()

	var got api.ThemeResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "dark", got.Theme)
}

func TestThemePut_EmptyString_MeansSystemAndIsAccepted(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"dark"}`, sessionCookie).Body.Close()

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":""}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.ThemeResponse
	require.NoError(t, readJSON(resp, &got))
	assert.Empty(t, got.Theme)
}

func TestThemePut_InvalidValue_Rejected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"purple"}`, sessionCookie)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestThemePut_DoesNotDisturbOtherSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings",
		`{"githubUsername":"ryan","renovateRebaseLabel":"retry"}`,
		sessionCookie).Body.Close()

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"light"}`, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()

	var got api.SettingsResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "ryan", got.GitHubUsername)
	assert.Equal(t, "retry", got.RenovateRebaseLabel)
	assert.Equal(t, "light", got.Theme)
}

func TestSettingsPut_ThenGet_RoundTripsRenovateRebaseLabel(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings",
		`{"renovateRebaseLabel":"retry"}`,
		sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()

	var got api.SettingsResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "retry", got.RenovateRebaseLabel)
}

func TestSettingsGet_FirstVisit_GeneratesWebhookCredentials(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.SettingsResponse
	require.NoError(t, readJSON(resp, &got))
	assert.NotEmpty(t, got.WebhookToken)
	assert.NotEmpty(t, got.WebhookSecret)
	assert.NotEqual(t, got.WebhookToken, got.WebhookSecret)
}

func TestSettingsGet_SecondVisit_ReturnsTheSameWebhookCredentials(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	first := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	var firstGot api.SettingsResponse
	require.NoError(t, readJSON(first, &firstGot))
	_ = first.Body.Close()

	second := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = second.Body.Close() }()
	var secondGot api.SettingsResponse
	require.NoError(t, readJSON(second, &secondGot))

	assert.Equal(t, firstGot.WebhookToken, secondGot.WebhookToken)
	assert.Equal(t, firstGot.WebhookSecret, secondGot.WebhookSecret)
}

func TestSettingsPut_DoesNotDisturbAlreadyGeneratedWebhookCredentials(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	var before api.SettingsResponse
	require.NoError(t, readJSON(getResp, &before))
	_ = getResp.Body.Close()

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"ryan"}`, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var after api.SettingsResponse
	require.NoError(t, readJSON(putResp, &after))
	assert.Equal(t, before.WebhookToken, after.WebhookToken)
	assert.Equal(t, before.WebhookSecret, after.WebhookSecret)
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
