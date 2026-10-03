package api_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Each pull request lists who was asked to review it and says whether that
// includes the signed-in user (#695), by the username saved in Settings for
// that forge.
func TestDashboard_PullRequestsSayWhetherTheirReviewIsRequestedFromMe(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, RequestedReviewerLogins: []string{"ryan"}},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, RequestedReviewerLogins: []string{"bob"}},
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
	putResp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+secretToken+`","githubUsername":"ryan"}`, cookie)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(prs) == 2
	}, 2e9, 10e6, "the background refresh should have picked up the fixture PRs")

	snap := fetchDashboardWith(t, srv.URL, cookie, "")

	byNumber := map[float64]map[string]any{}
	for _, p := range snap["pullRequests"].([]any) {
		pr := p.(map[string]any)
		byNumber[pr["number"].(float64)] = pr
	}
	assert.Equal(t, true, byNumber[1]["reviewRequestedFromMe"])
	assert.Equal(t, false, byNumber[2]["reviewRequestedFromMe"])
	assert.Equal(t, []any{"bob"}, byNumber[2]["requestedReviewerLogins"])
}
