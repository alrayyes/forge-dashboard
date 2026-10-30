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

// The response carries each rate-limit budget's numbers and no grade: the page
// grades them itself, from its own clock (#2929).
func TestDashboard_RateLimitsCarryTheNumbersAndNoGrade(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	reset := time.Now().Add(10 * time.Minute)
	source := &fakeConfiguredSource{health: dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1,
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset},
		RateLimitREST:    &dashboard.RateLimit{Limit: 5000, Remaining: 100, ResetsAt: reset},
	}}
	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	}
	srv := newTestServerWithSources(t, buildSources)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/v1/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(cookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := testClient(t).Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	var forge map[string]any
	require.Eventually(t, func() bool {
		forges, _ := fetchDashboardWith(t, srv.URL, cookie, "")["forges"].([]any)
		if len(forges) == 0 {
			return false
		}
		forge, _ = forges[0].(map[string]any)

		return forge["rateLimitGraphQL"] != nil
	}, pollBudget, 10*time.Millisecond, "the background refresh should have picked up the fixture")

	graphql, _ := forge["rateLimitGraphQL"].(map[string]any)
	rest, _ := forge["rateLimitREST"].(map[string]any)
	assert.InDelta(t, 0, graphql["remaining"], 0)
	assert.InDelta(t, 100, rest["remaining"], 0)
	assert.NotContains(t, graphql, "severity", "the page grades the numbers itself")
	assert.NotContains(t, rest, "severity", "the page grades the numbers itself")
}
