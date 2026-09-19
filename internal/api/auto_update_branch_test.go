package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAutoUpdateBranchEnable_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/api/repos/auto-update-branch/enable", "application/json", strings.NewReader(`{"forge":"github","fullName":"alrayyes/forge-dashboard"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestAutoUpdateBranchEnable_InvalidFullName_Returns400(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	resp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/enable", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestAutoUpdateBranchEnable_ThenDashboard_ReportsAutoUpdateBranchTrue(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	enableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/enable", "alrayyes/forge-dashboard")
	defer func() { _ = enableResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, enableResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, true, repo["autoUpdateBranch"])
}

func TestAutoUpdateBranchEnable_NotEnabled_ReportsAutoUpdateBranchFalse(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, false, repo["autoUpdateBranch"])
}

func TestAutoUpdateBranchDisable_RemovesIt(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)
	enableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/enable", "alrayyes/forge-dashboard")
	_ = enableResp.Body.Close()
	require.Equal(t, http.StatusNoContent, enableResp.StatusCode)

	disableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/disable", "alrayyes/forge-dashboard")
	defer func() { _ = disableResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, disableResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, false, repo["autoUpdateBranch"])
}

func TestAutoUpdateBranchDisable_NeverEnabled_IsANoOp(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	resp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/disable", "alrayyes/forge-dashboard")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestAutoUpdateBranchEnable_Idempotent_EnablingTwiceIsNotAnError(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	first := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/enable", "alrayyes/forge-dashboard")
	_ = first.Body.Close()
	require.Equal(t, http.StatusNoContent, first.StatusCode)

	second := postRepoAction(t, srvURL, sessionCookie, "/api/repos/auto-update-branch/enable", "alrayyes/forge-dashboard")
	defer func() { _ = second.Body.Close() }()
	assert.Equal(t, http.StatusNoContent, second.StatusCode)
}
