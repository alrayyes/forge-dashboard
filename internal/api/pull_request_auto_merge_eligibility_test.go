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

// autoMergeCountingSource lists one pull request and counts auto-merge calls,
// so a test can tell a refusal made by the server from one made by the forge.
type autoMergeCountingSource struct {
	fakeConfiguredSource
	enables atomic.Int32
}

func (s *autoMergeCountingSource) EnableAutoMerge(context.Context, string, string, int) error {
	s.enables.Add(1)

	return nil
}

func autoMergeBoard(t *testing.T, prs ...dashboard.PullRequest) (*httptest.Server, *http.Cookie, *autoMergeCountingSource) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &autoMergeCountingSource{}
	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}
	src.prs = prs
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

		return len(prs) == len(src.prs)
	}, time.Second, 10*time.Millisecond)

	return srv, cookie, src
}

func TestPullRequestAutoMerge_RefusesWhatAllowedActionsDoesNotOffer_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	base := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, MergeStatus: dashboard.MergeBlocked, CI: dashboard.CIPending}
	with := func(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
		pr := base
		mutate(&pr)

		return pr
	}
	off, on := false, true

	for name, tc := range map[string]struct {
		pr       dashboard.PullRequest
		wantCode string
	}{
		"already armed":        {with(func(p *dashboard.PullRequest) { p.AutoMergeEnabled = &on }), "not_mergeable"},
		"refused by the forge": {with(func(p *dashboard.PullRequest) { p.AutoMergeAllowed = &off }), "auto_merge_not_allowed"},
		"conflicting":          {with(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }), "conflict"},
		"empty":                {with(func(p *dashboard.PullRequest) { p.Empty = true }), "already_up_to_date"},
		"clean already": {
			with(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeMergeable; p.CI = dashboard.CISuccess }),
			"ready_to_merge",
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv, cookie, src := autoMergeBoard(t, tc.pr)

			resp := postAutoMerge(t, srv.URL, cookie, "alrayyes/a", 5)
			defer func() { _ = resp.Body.Close() }()
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)

			assert.Equal(t, http.StatusConflict, resp.StatusCode, string(body))
			var got map[string]any
			require.NoError(t, json.Unmarshal(body, &got))
			assert.Equal(t, tc.wantCode, got["code"])
			assert.Zero(t, src.enables.Load(), "the forge must not be asked")
		})
	}
}

func TestPullRequestAutoMerge_RefusesAStackedPullRequest(t *testing.T) {
	t.Parallel()

	parent := dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 4, HeadBranch: "feat-a", BaseBranch: "main"}
	child := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, HeadBranch: "feat-b", BaseBranch: "feat-a",
		MergeStatus: dashboard.MergeBlocked, CI: dashboard.CIPending,
	}
	srv, cookie, src := autoMergeBoard(t, parent, child)

	resp := postAutoMerge(t, srv.URL, cookie, "alrayyes/a", 5)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	assert.Equal(t, http.StatusConflict, resp.StatusCode, string(body))
	var got map[string]any
	require.NoError(t, json.Unmarshal(body, &got))
	assert.Equal(t, "stacked", got["code"])
	assert.Zero(t, src.enables.Load(), "the forge must not be asked")
}

func TestPullRequestAutoMerge_StillArmsAnEligiblePullRequest(t *testing.T) {
	t.Parallel()

	srv, cookie, src := autoMergeBoard(t, dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, MergeStatus: dashboard.MergeBlocked, CI: dashboard.CIPending,
	})

	resp := postAutoMerge(t, srv.URL, cookie, "alrayyes/a", 5)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, int32(1), src.enables.Load())
}
