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

// Stacked pull requests say so in the response (#860): where each sits, what
// it is stacked on, and what is stacked on it. Merge on the child is blocked
// with the stacked code.
func TestDashboard_StackedPullRequestsSaySoInTheResponse(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, URL: "https://github.com/alrayyes/a/pull/1", BaseBranch: "main", HeadBranch: "feat/a", MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, URL: "https://github.com/alrayyes/a/pull/2", BaseBranch: "feat/a", HeadBranch: "feat/b", MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3, URL: "https://github.com/alrayyes/a/pull/3", BaseBranch: "main", HeadBranch: "feat/c", MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess},
		},
	}
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	}
	srv := newTestServerWithSources(t, buildSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+secretToken+`"}`, cookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(prs) == 3
	}, 2*time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture PRs")

	snap := fetchDashboardWith(t, srv.URL, cookie, "")

	byNumber := map[float64]map[string]any{}
	for _, p := range snap["pullRequests"].([]any) {
		pr := p.(map[string]any)
		byNumber[pr["number"].(float64)] = pr
	}
	assert.Equal(t, map[string]any{"position": float64(2), "size": float64(2)}, byNumber[2]["stack"])
	assert.Equal(t, map[string]any{"number": float64(1), "url": "https://github.com/alrayyes/a/pull/1"}, byNumber[2]["stackedOn"])
	assert.Equal(t, []any{float64(2)}, byNumber[1]["stackChildren"])
	assert.Nil(t, byNumber[3]["stack"], "an unrelated pull request has none, as null")
	assert.Equal(t, "feat/a", byNumber[2]["baseBranch"])
	merge := mergeAction(t, byNumber[2])
	blocked, ok := merge["blocked"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "stacked", blocked["code"])
}

func mergeAction(t *testing.T, pr map[string]any) map[string]any {
	t.Helper()
	actions, ok := pr["allowedActions"].([]any)
	require.True(t, ok)
	for _, a := range actions {
		if entry := a.(map[string]any); entry["action"] == "merge" {
			return entry
		}
	}
	t.Fatal("no merge action listed")

	return nil
}
