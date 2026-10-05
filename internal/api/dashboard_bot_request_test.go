package api_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// botSource lists one pull request and accepts both bot triggers: Dependabot's
// comment and Renovate's label.
type botSource struct {
	fakeConfiguredSource
	fail error
}

func (s *botSource) CommentPullRequest(context.Context, string, string, int, string) error {
	return s.fail
}

func (s *botSource) AddLabel(context.Context, string, string, int, string) error { return s.fail }

func botBoard(t *testing.T, fail error) (*httptest.Server, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &botSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs:    []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Behind: true}},
		fail:   fail,
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+token+`"}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)

		return len(prs) == 1
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}

func botRequestOnBoard(t *testing.T, srv *httptest.Server, cookie *http.Cookie) any {
	t.Helper()

	prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)
	require.Len(t, prs, 1)

	return prs[0].(map[string]any)["botRequest"]
}

func TestDashboard_BotRequest_DependabotRebase_ShowsOnThePullRequest(t *testing.T) {
	t.Parallel()

	srv, cookie := botBoard(t, nil)
	require.Nil(t, botRequestOnBoard(t, srv, cookie), "no request yet")

	resp := postDependabotAction(t, srv.URL, cookie, "github", "alrayyes/a", 5, "recreate")
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	got, ok := botRequestOnBoard(t, srv, cookie).(map[string]any)
	require.True(t, ok, "the pull request should carry botRequest")
	assert.Equal(t, "dependabot", got["bot"])
	assert.Equal(t, "recreate", got["action"])
	assert.Equal(t, "queued", got["phase"])
	assert.NotEmpty(t, got["requestedAt"])
	assert.NotEmpty(t, got["expiresAt"])
}

func TestDashboard_BotRequest_RenovateRebase_ShowsOnThePullRequest(t *testing.T) {
	t.Parallel()

	srv, cookie := botBoard(t, nil)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/pull-requests/renovate-rebase",
		strings.NewReader(`{"forge":"github","fullName":"alrayyes/a","number":5}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	got, ok := botRequestOnBoard(t, srv, cookie).(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "renovate", got["bot"])
	assert.Equal(t, "rebase", got["action"])
}

func TestDashboard_BotRequest_TriggerRefused_RecordsNothing(t *testing.T) {
	t.Parallel()

	srv, cookie := botBoard(t, errors.New("boom"))

	resp := postDependabotAction(t, srv.URL, cookie, "github", "alrayyes/a", 5, "rebase")
	_ = resp.Body.Close()
	require.NotEqual(t, http.StatusNoContent, resp.StatusCode)

	assert.Nil(t, botRequestOnBoard(t, srv, cookie))
}
