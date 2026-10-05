package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// botCallsSource lists one pull request and counts the comment and label
// calls the two bots' commands make, so a test can tell a refusal made by the
// server from one made by the forge.
type botCallsSource struct {
	fakeConfiguredSource
	comments atomic.Int32
	labels   atomic.Int32
}

func (s *botCallsSource) CommentPullRequest(context.Context, string, string, int, string) error {
	s.comments.Add(1)

	return nil
}

func (s *botCallsSource) AddLabel(context.Context, string, string, int, string) error {
	s.labels.Add(1)

	return nil
}

func botCallsBoard(t *testing.T, pr dashboard.PullRequest) (*httptest.Server, *http.Cookie, *botCallsSource) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &botCallsSource{}
	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}
	src.prs = []dashboard.PullRequest{pr}
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

		return len(prs) == 1
	}, time.Second, 10*time.Millisecond)

	return srv, cookie, src
}

func humanPR(author string) dashboard.PullRequest {
	return dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Author: author,
		MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess,
	}
}

func TestPullRequestBotActions_RefuseAPullRequestThatIsNotThatBots_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		author string
		call   func(*testing.T, string, *http.Cookie) *http.Response
		calls  func(*botCallsSource) int32
	}{
		"dependabot rebase on a human PR": {
			"alice",
			func(t *testing.T, url string, c *http.Cookie) *http.Response {
				t.Helper()

				return postDependabotAction(t, url, c, "github", "alrayyes/a", 5, "rebase")
			},
			func(s *botCallsSource) int32 { return s.comments.Load() },
		},
		"dependabot recreate on a renovate PR": {
			"renovate[bot]",
			func(t *testing.T, url string, c *http.Cookie) *http.Response {
				t.Helper()

				return postDependabotAction(t, url, c, "github", "alrayyes/a", 5, "recreate")
			},
			func(s *botCallsSource) int32 { return s.comments.Load() },
		},
		"renovate rebase on a human PR": {
			"alice",
			func(t *testing.T, url string, c *http.Cookie) *http.Response {
				t.Helper()

				return postRenovateRebase(t, url, c, "github", "alrayyes/a", 5)
			},
			func(s *botCallsSource) int32 { return s.labels.Load() },
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv, cookie, src := botCallsBoard(t, humanPR(tc.author))

			resp := tc.call(t, srv.URL, cookie)
			defer func() { _ = resp.Body.Close() }()
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)

			assert.Equal(t, http.StatusConflict, resp.StatusCode, string(body))
			var got map[string]any
			require.NoError(t, json.Unmarshal(body, &got))
			assert.Equal(t, "not_mergeable", got["code"])
			assert.Zero(t, tc.calls(src), "the forge must not be asked")
		})
	}
}

func TestPullRequestBotActions_StillRunOnThatBotsPullRequest(t *testing.T) {
	t.Parallel()

	t.Run("dependabot", func(t *testing.T) {
		t.Parallel()

		srv, cookie, src := botCallsBoard(t, humanPR("dependabot[bot]"))

		resp := postDependabotAction(t, srv.URL, cookie, "github", "alrayyes/a", 5, "rebase")
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusNoContent, resp.StatusCode)
		assert.Equal(t, int32(1), src.comments.Load())
	})
	t.Run("renovate", func(t *testing.T) {
		t.Parallel()

		srv, cookie, src := botCallsBoard(t, humanPR("renovate[bot]"))

		resp := postRenovateRebase(t, srv.URL, cookie, "github", "alrayyes/a", 5)
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusNoContent, resp.StatusCode)
		assert.Equal(t, int32(1), src.labels.Load())
	})
}
