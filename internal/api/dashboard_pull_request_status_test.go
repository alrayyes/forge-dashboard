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

// Every pull request carries one status: what it is waiting on or blocked by,
// for a fixed place on the row (#1375). An empty one offers Close and no Merge,
// so the status is where its reason lives.
func TestDashboard_PullRequestsCarryOneStatus(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	pr := func(n int, mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
		p := dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: n, Title: "t", Author: "ryan",
			CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
		}
		mutate(&p)

		return p
	}
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(1, func(*dashboard.PullRequest) {}),
			pr(2, func(p *dashboard.PullRequest) { p.Empty = true }),
			pr(3, func(p *dashboard.PullRequest) { p.CI = dashboard.CIPending }),
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

		return len(prs) == 3
	}, time.Second, 10*time.Millisecond)

	got := fetchDashboard(t, srv.URL, cookie)
	byNumber := map[float64]map[string]any{}
	for _, p := range got["pullRequests"].([]any) {
		entry := p.(map[string]any)
		byNumber[entry["number"].(float64)] = entry
	}

	assert.Contains(t, byNumber[1], "status", "status is always present")
	assert.Nil(t, byNumber[1]["status"], "a pull request ready to merge is waiting on nothing")

	empty := byNumber[2]
	assert.ElementsMatch(t, []string{"close"}, actionNames(t, empty), "an empty pull request offers Close only")
	status, ok := empty["status"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "already_up_to_date", status["code"])
	assert.Equal(t, "Nothing to merge: the branch is already on the target branch.", status["message"])

	waiting, ok := byNumber[3]["status"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "checks_pending", waiting["code"])
	assert.Equal(t, "Waiting for CI to finish", waiting["message"])
}

func actionNames(t *testing.T, pr map[string]any) []string {
	t.Helper()

	actions, ok := pr["allowedActions"].([]any)
	require.True(t, ok)
	out := make([]string, 0, len(actions))
	for _, a := range actions {
		out = append(out, a.(map[string]any)["action"].(string))
	}

	return out
}
