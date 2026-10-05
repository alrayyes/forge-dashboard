package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mergeCountingSource lists one pull request and counts merge calls, so a
// test can tell a refusal made by the server from one made by the forge.
type mergeCountingSource struct {
	fakeConfiguredSource
	merges atomic.Int32
}

func (s *mergeCountingSource) MergePullRequest(context.Context, string, string, int) error {
	s.merges.Add(1)

	return nil
}

func eligibilityBoard(t *testing.T, pr dashboard.PullRequest) (*httptest.Server, *http.Cookie, *mergeCountingSource) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &mergeCountingSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs:    []dashboard.PullRequest{pr},
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
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(prs) == 1
	}, time.Second, 10*time.Millisecond)

	return srv, cookie, src
}

func TestPullRequestMerge_RefusesWhatAllowedActionsBlocks_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	srv, cookie, src := eligibilityBoard(t, dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Draft: true,
		MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess,
	})

	resp := postMergePullRequest(t, srv.URL, cookie, "github", "alrayyes/a", 5)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	assert.Equal(t, http.StatusConflict, resp.StatusCode, string(body))
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	assert.Equal(t, "not_mergeable", got["code"])
	assert.NotEmpty(t, got["message"])
	assert.Zero(t, src.merges.Load(), "the forge must not be asked")
}

func TestPullRequestMerge_StillMergesWhatAllowedActionsOffers(t *testing.T) {
	t.Parallel()

	srv, cookie, src := eligibilityBoard(t, dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5,
		MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess,
	})

	resp := postMergePullRequest(t, srv.URL, cookie, "github", "alrayyes/a", 5)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, int32(1), src.merges.Load())
}
