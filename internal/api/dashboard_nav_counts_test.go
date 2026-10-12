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
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "Dependency Dashboard", Author: "renovate[bot]"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug"},
		},
		branches: []dashboard.MainBranch{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", Status: dashboard.MainBranchFailed},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b", Status: dashboard.MainBranchPassed},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/c", Status: dashboard.MainBranchNone},
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

	got := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, map[string]any{"total": 3.0, "failed": 1.0}, navCount(t, got, "pullRequests"))
	assert.Equal(t, map[string]any{"total": 2.0, "failed": 1.0}, navCount(t, got, "releases"))
	assert.Equal(t, map[string]any{"total": 3.0, "failed": 2.0}, navCount(t, got, "bots"))
	assert.Equal(t, map[string]any{"total": 3.0, "failed": 1.0}, navCount(t, got, "branches"),
		"a branch with no pipeline counts in the total and isn't failed")
	assert.Equal(t, map[string]any{"total": 1.0}, navCount(t, got, "issues"),
		"housekeeping issues stay out, as in openIssueCount; Issues has no failed number")
}

func TestDashboard_NavCountsAreZeroNotMissingWhenNothingIsTracked(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	got := fetchDashboard(t, srv.URL, cookie)

	for _, page := range []string{"branches", "pullRequests", "releases", "bots"} {
		assert.Equal(t, map[string]any{"total": 0.0, "failed": 0.0}, navCount(t, got, page), page)
	}
	assert.Equal(t, map[string]any{"total": 0.0}, navCount(t, got, "issues"))
}
