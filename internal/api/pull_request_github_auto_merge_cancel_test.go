package api_test

import (
	"net/http"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func postCancelAutoMerge(t *testing.T, srvURL string, cookie *http.Cookie, fullName string, number int) *http.Response {
	t.Helper()

	return doJSON(t, http.MethodPost, srvURL+"/api/pull-requests/auto-merge/cancel",
		`{"forge":"github","fullName":"`+fullName+`","number":`+strconv.Itoa(number)+`}`, cookie)
}

func armedGitHubPR(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
	on := true
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5,
		MergeStatus: dashboard.MergeBlocked, CI: dashboard.CIPending, AutoMergeEnabled: &on,
	}
	if mutate != nil {
		mutate(&pr)
	}

	return pr
}

// GitHub's auto-merge is taken back with GitHub's own mutation (#1293).
func TestGitHubAutoMerge_Cancel_DisablesItOnGitHub(t *testing.T) {
	t.Parallel()

	srv, cookie, src := autoMergeBoard(t, armedGitHubPR(nil))

	resp := postCancelAutoMerge(t, srv.URL, cookie, "alrayyes/a", 5)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, int32(1), src.disables.Load())
}

func TestGitHubAutoMerge_Cancel_NotArmed_IsRefusedWithoutAskingGitHub(t *testing.T) {
	t.Parallel()

	srv, cookie, src := autoMergeBoard(t, armedGitHubPR(func(p *dashboard.PullRequest) { p.AutoMergeEnabled = nil }))

	resp := postCancelAutoMerge(t, srv.URL, cookie, "alrayyes/a", 5)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	assert.Zero(t, src.disables.Load(), "the forge must not be asked")
}

func TestGitHubAutoMerge_Armed_BoardSaysItIsWaiting(t *testing.T) {
	t.Parallel()

	srv, cookie, _ := autoMergeBoard(t, armedGitHubPR(nil))

	prs, ok := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)
	require.True(t, ok)
	require.Len(t, prs, 1)
	status, ok := prs[0].(map[string]any)["autoMerge"].(map[string]any)
	require.True(t, ok, "an armed GitHub pull request carries an autoMerge status")
	assert.Equal(t, "waiting", status["state"])
}
