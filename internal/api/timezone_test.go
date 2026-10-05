package api_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTimezoneGet_NothingSavedYet_ReturnsEmptyMeaningBrowser(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/timezone", "", sessionCookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got api.TimezoneResponse
	require.NoError(t, readJSON(resp, &got))
	assert.Empty(t, got.Timezone)
}

func TestTimezoneGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)

	resp, err := http.Get(srv.URL + "/api/settings/timezone")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestTimezonePut_ThenGet_RoundTrips(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/timezone", `{"timezone":"Europe/Amsterdam"}`, sessionCookie)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/timezone", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	var got api.TimezoneResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "Europe/Amsterdam", got.Timezone)
}

func TestTimezonePut_AcceptsUTCAndEmpty(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	for _, body := range []string{`{"timezone":"UTC"}`, `{"timezone":""}`} {
		resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/timezone", body, sessionCookie)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode, body)
	}
}

func TestTimezonePut_NotAnIANAName_Rejected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	for _, body := range []string{`{"timezone":"Mars/Olympus"}`, `{"timezone":"Local"}`, `{"timezone":"../etc/passwd"}`} {
		resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/timezone", body, sessionCookie)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, body)
	}
}

func TestTimezonePut_DoesNotDisturbOtherSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings/theme", `{"theme":"dark"}`, sessionCookie).Body.Close()
	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"ryan"}`, sessionCookie).Body.Close()

	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings/timezone", `{"timezone":"Europe/Amsterdam"}`, sessionCookie)
	_ = putResp.Body.Close()

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	var got api.SettingsResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "ryan", got.GitHubUsername)
	assert.Equal(t, "dark", got.Theme)
}

func TestSettingsPut_DoesNotAcceptOrDisturbTimezone(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings/timezone", `{"timezone":"Europe/Amsterdam"}`, sessionCookie).Body.Close()

	_ = doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubUsername":"ryan","timezone":"UTC"}`, sessionCookie).Body.Close()

	getResp := doJSON(t, http.MethodGet, srv.URL+"/api/settings/timezone", "", sessionCookie)
	defer func() { _ = getResp.Body.Close() }()
	var got api.TimezoneResponse
	require.NoError(t, readJSON(getResp, &got))
	assert.Equal(t, "Europe/Amsterdam", got.Timezone, "the main settings PUT must not be able to change the timezone")
}
