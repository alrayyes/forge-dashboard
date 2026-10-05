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

// Each pull request in the response carries its kind (#716), worked out on the
// server, so no client needs the rule.
func TestDashboard_EachPullRequestCarriesItsKind(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	pr := func(number int, author string, labels ...dashboard.Label) dashboard.PullRequest {
		return dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: number, Author: author, Labels: labels}
	}
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(1, "alice"),
			pr(2, "dependabot[bot]"),
			pr(3, "renovate"),
			pr(4, "alice", dashboard.Label{Name: "autorelease: pending"}),
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
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(prs) == 4
	}, time.Second, 10*time.Millisecond)

	kinds := map[int]string{}
	prs, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)
	for _, raw := range prs {
		item := raw.(map[string]any)
		kinds[int(item["number"].(float64))], _ = item["kind"].(string)
	}
	assert.Equal(t, map[int]string{1: "regular", 2: "dependency", 3: "dependency", 4: "release"}, kinds)
}
