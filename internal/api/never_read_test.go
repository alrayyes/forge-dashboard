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

// A forge still on its first read has no rows. That is not an empty board, so
// nothing may say the viewer has no pull requests, issues or repos.

// slowFirstReadBoard is a signed-in viewer's board after a refresh that left
// the only forge still on its first read, with the rows prs from before it.
func slowFirstReadBoard(t *testing.T, prs ...dashboard.PullRequest) (url string, cookie *http.Cookie) {
	t.Helper()

	srv := newTestServerWithSources(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != countsToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{
			health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, Cause: dashboard.ForgeCauseSlow},
			prs:    prs,
		}}
	})
	cookie, _, _ = registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool {
		forges, _ := fetchDashboardWith(t, srv.URL, cookie, "")["forges"].([]any)

		return len(forges) == 1
	}, pollBudget, 10*time.Millisecond)

	return srv.URL, cookie
}

func TestDashboard_FirstRefreshDone_FalseWhileANeverReadForgeLeavesTheBoardEmpty(t *testing.T) {
	t.Parallel()

	url, cookie := slowFirstReadBoard(t)

	assert.Equal(t, false, firstRefreshDoneOverHTTP(t, url, cookie))
}

func TestDashboard_FirstRefreshDone_TrueWhenThereArePullRequestsToShow(t *testing.T) {
	t.Parallel()

	url, cookie := slowFirstReadBoard(t, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1})

	assert.Equal(t, true, firstRefreshDoneOverHTTP(t, url, cookie))
}

func TestSettingsGet_IgnoredTitleCounts_AreNullWhileTheOnlyForgeIsStillOnItsFirstRead(t *testing.T) {
	t.Parallel()

	url, cookie := slowFirstReadBoard(t)

	assert.Equal(t, []*int{nil}, getSettings(t, url, cookie).IgnoredTitleCounts)
}

func TestSetupGet_NotRefreshedWhileAForgeIsStillOnItsFirstRead(t *testing.T) {
	t.Parallel()

	url, cookie := slowFirstReadBoard(t)
	resp := doJSON(t, http.MethodGet, url+"/api/v1/setup", "", cookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body map[string]any
	require.NoError(t, readJSON(resp, &body))

	assert.Equal(t, false, body["refreshed"])
}
