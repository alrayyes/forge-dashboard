package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func readJSON(resp *http.Response, v any) error {
	defer func() { _ = resp.Body.Close() }()
	return json.NewDecoder(resp.Body).Decode(v)
}

func TestHealthz_AnswersOK(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/healthz")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body api.Health
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "ok", body.Status)
}

func TestDashboard_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/api/dashboard")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestDashboard_WithASessionButNoSettingsSaved_SerializesEmptyArraysNotNull(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.NotContains(t, string(body), "null", "a user with nothing configured yet should still get empty arrays, not null")
}

// fakeConfiguredSource stands in for a real github/forgejo source in
// tests that care about the settings→dashboard wiring, not about
// internal/github or internal/forgejo themselves — each has its own
// tests for that.
type fakeConfiguredSource struct {
	health dashboard.ForgeHealth
}

func (s *fakeConfiguredSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: s.health}
}

func TestSettingsPut_TriggersTheDashboardToReflectTheNewSources(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	wantHealth := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}

	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
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

	require.Eventually(t, func() bool {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
		if err != nil {
			return false
		}
		req.AddCookie(sessionCookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()
		var snap dashboard.Snapshot
		if err := readJSON(resp, &snap); err != nil {
			return false
		}
		return len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 3
	}, time.Second, 10*time.Millisecond, "saving settings should start a background refresh that the dashboard picks up")
}
