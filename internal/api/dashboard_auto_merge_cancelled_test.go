package api_test

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// cancellingSource is a GitHub source whose pull request reads as armed until
// its auto-merge is disabled, as the forge would.
type cancellingSource struct {
	autoMergeCountingSource
}

func (s *cancellingSource) Fetch(ctx context.Context) dashboard.Result {
	res := s.autoMergeCountingSource.Fetch(ctx)
	if s.disables.Load() > 0 {
		off := false
		prs := make([]dashboard.PullRequest, len(res.PullRequests))
		for i, pr := range res.PullRequests {
			pr.AutoMergeEnabled = &off
			prs[i] = pr
		}
		res.PullRequests = prs
	}

	return res
}

// Once the app has cancelled an armed auto-merge on a pull request that went
// empty, the auto-merge is off, so the row needs the reason from somewhere: the
// pull request's autoMerge status keeps it for a few minutes (#1375).
func TestDashboard_ACancelledAutoMergeOnAnEmptyPullRequestSaysWhy(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	on := true
	src := &cancellingSource{}
	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}
	src.prs = []dashboard.PullRequest{{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Title: "t", Author: "ryan",
		Empty: true, AutoMergeEnabled: &on, CI: dashboard.CIPending, MergeStatus: dashboard.MergeBlocked,
	}}
	srv, _, _ := newTestServerWithAutoMerge(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	}, true)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool { return src.disables.Load() == 1 }, 2*time.Second, 10*time.Millisecond, "the app cancelled it")

	var status map[string]any
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)
		if len(prs) != 1 {
			return false
		}
		status, _ = prs[0].(map[string]any)["autoMerge"].(map[string]any)

		// Until the next read the forge still says armed, and the status says
		// "stopped: nothing left to merge"; then the cancel is the reason.
		return status != nil && status["message"] == "Auto-merge was cancelled: there is nothing left to merge."
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, "stopped", status["state"])
	assert.Equal(t, "already_up_to_date", status["code"])
	assert.Equal(t, "Auto-merge was cancelled: there is nothing left to merge.", status["message"])
	assert.Equal(t, int32(1), src.disables.Load(), "and only once")
}
