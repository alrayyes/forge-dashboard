package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func navCount(t *testing.T, got map[string]any, page string) map[string]any {
	t.Helper()
	nav, ok := got["navCounts"].(map[string]any)
	require.True(t, ok, "navCounts is always present")
	counts, ok := nav[page].(map[string]any)
	require.True(t, ok, "navCounts.%s is always present", page)

	return counts
}

// The nav badges show a total and a failed number for every page (#1315), so
// a client reads them from the snapshot it already has, and the stream keeps
// them live.
func TestDashboard_NavCountsTotalAndFailedPerPage(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	draft := func(p dashboard.PullRequest) dashboard.PullRequest {
		p.Draft = true

		return p
	}
	pr := func(n int, ci dashboard.CIStatus, author string, labels ...string) dashboard.PullRequest {
		p := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: n, Title: "t", CI: ci, Author: author}
		for _, l := range labels {
			p.Labels = append(p.Labels, dashboard.Label{Name: l})
		}

		return p
	}
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(1, dashboard.CIFailure, "ryan"),
			pr(2, dashboard.CISuccess, "ryan"),
			pr(3, dashboard.CIPending, "ryan"),
			pr(4, dashboard.CIFailure, "ryan", "autorelease: pending"),
			pr(5, dashboard.CISuccess, "ryan", "autorelease: pending"),
			pr(6, dashboard.CIFailure, "dependabot"),
			pr(7, dashboard.CIFailure, "dependabot[bot]"),
			pr(8, dashboard.CINone, "dependabot"),
			draft(pr(9, dashboard.CIFailure, "ryan")),
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "Dependency Dashboard", Author: "renovate[bot]"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug"},
		},
		branches: []dashboard.MainBranch{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", Status: dashboard.MainBranchFailed},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b", Status: dashboard.MainBranchPassed},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/c", Status: dashboard.MainBranchNone},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/d", Status: dashboard.MainBranchRunning},
		},
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)

		return len(prs) == 8
	}, time.Second, 10*time.Millisecond)

	got := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")
	prs, _ := got["pullRequests"].([]any)
	require.Len(t, prs, 9, "the draft is listed when the request asks for it")

	assert.Equal(t, map[string]any{"total": 3.0, "running": 1.0, "failed": 1.0, "passed": 1.0}, navCount(t, got, "pullRequests"))
	assert.Equal(t, map[string]any{"total": 2.0, "running": 0.0, "failed": 1.0, "passed": 1.0}, navCount(t, got, "releases"))
	assert.Equal(t, map[string]any{"total": 3.0, "running": 0.0, "failed": 2.0, "passed": 0.0}, navCount(t, got, "bots"),
		"a pull request with no checks counts in the total only, so the four need not add up")
	assert.Equal(t, map[string]any{"total": 4.0, "failed": 1.0}, navCount(t, got, "branches"),
		"a branch with no pipeline, or still running, counts in the total and isn't failed")
	assert.Equal(t, got["navCounts"], fetchDashboard(t, srv.URL, cookie)["navCounts"],
		"showing drafts changes the list, not the badge")
	assert.Equal(t, map[string]any{"total": 1.0}, navCount(t, got, "issues"),
		"housekeeping issues stay out, as in openIssueCount; Issues has no failed number")
}

func TestDashboard_NavCountsAreZeroNotMissingWhenNothingIsTracked(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	got := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, map[string]any{"total": 0.0, "failed": 0.0}, navCount(t, got, "branches"), "branches")
	for _, page := range []string{"pullRequests", "releases", "bots"} {
		assert.Equal(t, map[string]any{"total": 0.0, "running": 0.0, "failed": 0.0, "passed": 0.0}, navCount(t, got, page), page)
	}
	assert.Equal(t, map[string]any{"total": 0.0}, navCount(t, got, "issues"))
}

func TestDashboard_NavCountsLeaveOutAnIgnoredRepo(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newTestServerWithRepo(t)
	require.Eventually(t, func() bool {
		return navCount(t, fetchDashboard(t, srvURL, cookie), "pullRequests")["total"] == 1.0
	}, time.Second, 10*time.Millisecond, "counted before it is ignored")
	resp := postRepoIgnoreAction(t, srvURL, cookie, "alrayyes/forge-dashboard", true, false)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	got := fetchDashboard(t, srvURL, cookie)

	assert.Equal(t, map[string]any{"total": 0.0, "running": 0.0, "failed": 0.0, "passed": 0.0}, navCount(t, got, "pullRequests"))
}

func TestDashboard_NavCountsIgnoreTheShowHiddenToggle(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	shown := fetchDashboardWith(t, srvURL, cookie, "?includeHidden=true")
	require.Equal(t, []int{1, 2}, boardNumbers(t, srvURL, cookie, "?includeHidden=true"), "the hidden one is listed on request")

	assert.Equal(t, map[string]any{"total": 1.0, "running": 0.0, "failed": 0.0, "passed": 0.0}, navCount(t, shown, "pullRequests"),
		"a hidden pull request is never in the badge")
	assert.Equal(t, shown["navCounts"], fetchDashboard(t, srvURL, cookie)["navCounts"])
}
