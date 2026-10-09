package api_test

import (
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDashboardRefresh_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/api/dashboard/refresh", "", nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDashboardRefresh_NoBackgroundRefreshYet_Returns404(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/dashboard/refresh", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestDashboardRefresh_ReturnsTheFreshSnapshot(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	wantHealth := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}

	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: wantHealth}}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	defer func() { _ = putResp.Body.Close() }()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	refreshReq, err := http.NewRequest(http.MethodPost, srv.URL+"/api/dashboard/refresh", nil)
	require.NoError(t, err)
	refreshReq.AddCookie(sessionCookie)
	refreshResp, err := http.DefaultClient.Do(refreshReq)
	require.NoError(t, err)
	defer func() { _ = refreshResp.Body.Close() }()
	require.Equal(t, http.StatusOK, refreshResp.StatusCode)

	var snap dashboard.Snapshot
	require.NoError(t, readJSON(refreshResp, &snap))
	require.Len(t, snap.Forges, 1)
	assert.Equal(t, wantHealth, snap.Forges[0])
}

// A refresh inside the cooldown answers with the current snapshot and says
// how long to wait, instead of fetching or refusing (#809).
func TestDashboardRefresh_InsideTheCooldown_AnswersWithRetryAfter(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	})
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+secretToken+`"}`, sessionCookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	refresh := func() (status int, retryAfter string) {
		resp := doJSON(t, http.MethodPost, srv.URL+"/api/dashboard/refresh", "", sessionCookie)
		defer func() { _ = resp.Body.Close() }()

		return resp.StatusCode, resp.Header.Get("Retry-After")
	}

	_, firstRetryAfter := refresh()
	secondStatus, secondRetryAfter := refresh()

	assert.Empty(t, firstRetryAfter, "the call that fetched")
	assert.Equal(t, http.StatusOK, secondStatus)
	retryAfter, err := strconv.Atoi(secondRetryAfter)
	require.NoError(t, err)
	assert.Positive(t, retryAfter)
	assert.LessOrEqual(t, retryAfter, 5)
}
