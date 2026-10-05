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

// Which issues are real work is a server rule (#980): a second client counts
// the same ones the web badge does.
func TestDashboard_FlagsHousekeepingIssuesAndCountsTheRest(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "Dependency Dashboard", Author: "renovate[bot]"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3, Title: "Another real bug"},
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
		issues, _ := fetchDashboard(t, srv.URL, cookie)["issues"].([]any)

		return len(issues) == 3
	}, time.Second, 10*time.Millisecond)

	got := fetchDashboard(t, srv.URL, cookie)
	assert.InDelta(t, 2, got["openIssueCount"], 0)

	flags := map[string]bool{}
	for _, raw := range got["issues"].([]any) {
		issue := raw.(map[string]any)
		flags[strings.TrimSpace(issue["title"].(string))], _ = issue["housekeeping"].(bool)
	}
	assert.True(t, flags["Dependency Dashboard"])
	assert.False(t, flags["A real bug"])
	assert.False(t, flags["Another real bug"])
}
