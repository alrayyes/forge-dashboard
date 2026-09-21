package api_test

import (
	"context"
	"encoding/json"
	"fmt"
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

	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		return fmt.Errorf("decode response body: %w", err)
	}

	return nil
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
	prs    []dashboard.PullRequest
	issues []dashboard.Issue
	repos  []dashboard.Repo
}

func (s *fakeConfiguredSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: s.health, PullRequests: s.prs, Issues: s.issues, Repos: s.repos}
}

func (s *fakeConfiguredSource) Forge() dashboard.Forge { return s.health.Forge }

func TestSettingsPut_TriggersTheDashboardToReflectTheNewSources(t *testing.T) {
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

func TestDashboard_AfterAProcessRestart_LazilyRewarmsFromSavedSettings(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	wantHealth := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}

	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: wantHealth}}
	}

	srv, manager, _ := newTestServerWithSourcesAndManager(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	dashboardReq := func() (dashboard.Snapshot, int) {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
		require.NoError(t, err)
		req.AddCookie(sessionCookie)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		var snap dashboard.Snapshot
		require.NoError(t, readJSON(resp, &snap))

		return snap, resp.StatusCode
	}

	require.Eventually(t, func() bool {
		snap, status := dashboardReq()

		return status == http.StatusOK && len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 3
	}, time.Second, 10*time.Millisecond, "settings should have started a background refresh before simulating a restart")

	// Simulate a process restart: Manager.Stop cancels every running
	// refresh loop and clears its map, the same effect on Manager state a
	// real restart has — the session cookie (stored in the auth DB) and
	// the saved Settings (stored in the settings DB) both survive it,
	// only the in-memory Aggregator doesn't.
	manager.Stop()

	// Without a fresh login, the existing session should still lazily
	// rewarm from saved Settings — not show the zero-value empty
	// snapshot forever the way it did before this fix. Real bug reported
	// live: "no PRs or issues are shown" with a "Refreshed 739872d ago"
	// footer, matching Go's zero-value time.Time serialized and diffed
	// against now. The rewarm itself is async (Manager.Ensure starts a
	// background refresh rather than blocking this request on it, same
	// as handleDashboard's own doc comment promises), so this asserts
	// eventual convergence, not an instant one.
	require.Eventually(t, func() bool {
		snap, status := dashboardReq()

		return status == http.StatusOK && !snap.GeneratedAt.IsZero() && len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 3
	}, time.Second, 10*time.Millisecond, "a lazily rewarmed dashboard should reflect the previously saved sources again, not stay stuck at the zero-value snapshot")
}

func TestDashboard_WithOwnerQuery_UnsharedViewer_Refused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay) // bootstraps as admin
	token := createInviteViaAdmin(t, srv, ownerCookie, testOtherUser, "Alex")
	viewerCookie, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard?owner="+testUser, nil)
	require.NoError(t, err)
	req.AddCookie(viewerCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestDashboard_WithOwnerQuery_UnknownOwner_NotFound(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard?owner=nobody-registered", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestDashboard_WithOwnerQuery_SharedViewer_SeesTheOwnersDashboard(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-owner-token" // #nosec G101 -- a fake test fixture, not a real credential
	wantHealth := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 9}

	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: wantHealth}}
	}

	srv := newTestServerWithSources(t, buildSources)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay) // bootstraps as admin
	token := createInviteViaAdmin(t, srv, ownerCookie, testOtherUser, "Alex")
	viewerCookie, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(ownerCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	shareReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/sharing/"+testOtherUser, nil)
	require.NoError(t, err)
	shareReq.AddCookie(ownerCookie)
	shareResp, err := http.DefaultClient.Do(shareReq)
	require.NoError(t, err)
	_ = shareResp.Body.Close()
	require.Equal(t, http.StatusNoContent, shareResp.StatusCode)

	require.Eventually(t, func() bool {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard?owner="+testUser, nil)
		if err != nil {
			return false
		}
		req.AddCookie(viewerCookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer func() { _ = resp.Body.Close() }()
		var snap dashboard.Snapshot
		if err := readJSON(resp, &snap); err != nil {
			return false
		}

		return len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 9
	}, time.Second, 10*time.Millisecond, "a shared viewer should see the owner's dashboard, not their own empty one")
}
