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

// updateBranchServer tracks two behind pull requests on alrayyes/a: #1 is
// clean, #2 conflicts. autoUpdate turns auto-update-branch on for that repo
// before the first dashboard fetch (#1080).
func updateBranchServer(t *testing.T, autoUpdate bool) (srvURL string, sessionCookie *http.Cookie) {
	t.Helper()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Behind: true, MergeStatus: dashboard.MergeConflicting},
		},
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	})
	sessionCookie, _, _ = registerViaRealCeremony(t, srv, testUser, testDisplay)

	send := func(method, path, body string) {
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(sessionCookie)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		_ = resp.Body.Close()
		require.Less(t, resp.StatusCode, 300)
	}
	if autoUpdate {
		send(http.MethodPost, "/api/repos/auto-update-branch/enable", `{"forge":"github","fullName":"alrayyes/a"}`)
	}
	send(http.MethodPut, "/api/settings", `{"githubToken":"`+secretToken+`"}`)

	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, sessionCookie, "")["pullRequests"].([]any)

		return len(prs) == 2
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture PRs")

	return srv.URL, sessionCookie
}

// updateBranchEntries maps each pull request number to its update_branch
// entry, or nil when the pull request doesn't list one.
func updateBranchEntries(t *testing.T, srvURL string, cookie *http.Cookie) map[int]map[string]any {
	t.Helper()

	out := map[int]map[string]any{}
	prs, ok := fetchDashboardWith(t, srvURL, cookie, "")["pullRequests"].([]any)
	require.True(t, ok)
	for _, p := range prs {
		pr := p.(map[string]any)
		number := int(pr["number"].(float64))
		out[number] = nil
		actions, _ := pr["allowedActions"].([]any)
		for _, a := range actions {
			if entry := a.(map[string]any); entry["action"] == "update_branch" {
				out[number] = entry
			}
		}
	}

	return out
}

func TestDashboard_UpdateBranchIsOfferedWhereAutoUpdateIsOff(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, false)

	entries := updateBranchEntries(t, srvURL, cookie)

	require.NotNil(t, entries[1])
	assert.NotContains(t, entries[1], "blocked")
	assert.NotNil(t, entries[2])
}

func TestDashboard_UpdateBranchIsLeftOutWhereAutoUpdateIsOn(t *testing.T) {
	t.Parallel()

	srvURL, cookie := updateBranchServer(t, true)

	entries := updateBranchEntries(t, srvURL, cookie)

	assert.Nil(t, entries[1], "the app updates this one itself")
	require.NotNil(t, entries[2], "a conflict is the user's to fix, so it keeps saying so")
	assert.Equal(t, "conflict", entries[2]["blocked"].(map[string]any)["code"])
}
