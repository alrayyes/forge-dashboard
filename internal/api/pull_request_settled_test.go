package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubbornForge goes on listing a pull request as open after a merge or close
// succeeded on it, the way a forge can for a few seconds (#835).
type stubbornForge struct {
	fakePullRequestMergerSource
}

func (f *stubbornForge) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: f.forge, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: f.forge, Repo: "alrayyes/a", Number: 1}, {Forge: f.forge, Repo: "alrayyes/a", Number: 2}},
	}
}

func (f *stubbornForge) ClosePullRequest(context.Context, string, string, int) error { return nil }

func refreshedNumbers(t *testing.T, srvURL string, cookie *http.Cookie) []float64 {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/dashboard/refresh", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var snap map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&snap))

	return prNumbers(t, snap)
}

func TestPullRequestActions_ASucceededMergeOrCloseLeavesTheBoardAtOnce(t *testing.T) {
	t.Parallel()

	for name, act := range map[string]func(*testing.T, string, *http.Cookie) *http.Response{
		"merge": func(t *testing.T, url string, c *http.Cookie) *http.Response {
			t.Helper()

			return postMergePullRequest(t, url, c, "github", "alrayyes/a", 1)
		},
		"close": func(t *testing.T, url string, c *http.Cookie) *http.Response {
			t.Helper()

			return postClosePullRequest(t, url, c, "github", "alrayyes/a", 1)
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, &stubbornForge{fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}})
			require.Eventually(t, func() bool {
				return len(fetchDashboardWith(t, srvURL, cookie, "")["pullRequests"].([]any)) == 2
			}, 2*time.Second, 10*time.Millisecond, "the background refresh should list both pull requests")

			resp := act(t, srvURL, cookie)
			_ = resp.Body.Close()
			require.Equal(t, http.StatusNoContent, resp.StatusCode)

			assert.Equal(t, []float64{2}, refreshedNumbers(t, srvURL, cookie), "the forge still lists #1 as open, but the board must not")
		})
	}
}

func TestPullRequestMerge_ARefusedMergeHidesNothing(t *testing.T) {
	t.Parallel()

	source := &stubbornForge{fakePullRequestMergerSource{forge: dashboard.ForgeGitHub, mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT x: Pull Request is not mergeable")}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	require.Eventually(t, func() bool {
		return len(fetchDashboardWith(t, srvURL, cookie, "")["pullRequests"].([]any)) == 2
	}, 2*time.Second, 10*time.Millisecond)

	resp := postMergePullRequest(t, srvURL, cookie, "github", "alrayyes/a", 1)
	_ = resp.Body.Close()
	require.NotEqual(t, http.StatusNoContent, resp.StatusCode)

	assert.Equal(t, []float64{1, 2}, refreshedNumbers(t, srvURL, cookie))
}
