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

// Each pull request and issue carries its author's profile page, built on the
// server from the forge's own web address, so no client needs a rule per forge.
func TestDashboard_EachItemCarriesItsAuthorsProfileURL(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, URL: "https://github.com/alrayyes/a/pull/1", Author: "alice"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, URL: "https://github.com/alrayyes/a/pull/2", Author: "dependabot[bot]"},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3, URL: "https://github.com/alrayyes/a/pull/3", Author: "ghost"},
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 9, URL: "https://github.com/alrayyes/a/issues/9", Author: "claude"},
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

		return len(prs) == 3
	}, time.Second, 10*time.Millisecond)

	body := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")
	prURLs := map[int]string{}
	for _, raw := range body["pullRequests"].([]any) {
		item := raw.(map[string]any)
		prURLs[int(item["number"].(float64))], _ = item["authorUrl"].(string)
	}
	issueURLs := map[int]string{}
	for _, raw := range body["issues"].([]any) {
		item := raw.(map[string]any)
		issueURLs[int(item["number"].(float64))], _ = item["authorUrl"].(string)
	}

	t.Run("pull requests", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, map[int]string{
			1: "https://github.com/alice",
			2: "https://github.com/apps/dependabot",
			3: "",
		}, prURLs)
	})
	t.Run("issues", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, map[int]string{9: "https://github.com/claude"}, issueURLs)
	})
}
