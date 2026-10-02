package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestDashboard_PullRequest_SerializesReviewState checks /api/dashboard
// carries a PR's review object (#683) and omits it when unknown.
func TestDashboard_PullRequest_SerializesReviewState(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	known := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1,
		Review: &dashboard.ReviewState{Decision: dashboard.ReviewRequired, RequestedReviewers: 2},
	}
	unknown := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2}
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs:    []dashboard.PullRequest{known, unknown},
	}
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var prs []any
	require.Eventually(t, func() bool {
		snap := fetchDashboard(t, srv.URL, sessionCookie)
		var ok bool
		prs, ok = snap["pullRequests"].([]any)

		return ok && len(prs) == 2
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture PRs")

	byNumber := map[float64]map[string]any{}
	for _, p := range prs {
		pr := p.(map[string]any)
		byNumber[pr["number"].(float64)] = pr
	}
	assert.Equal(t, map[string]any{"decision": "review_required", "approvals": float64(0), "requestedReviewers": float64(2)}, byNumber[1]["review"])
	assert.NotContains(t, byNumber[2], "review", "unknown review state is omitted, never null or none")
}
