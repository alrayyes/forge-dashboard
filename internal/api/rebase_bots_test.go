package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRebaseBotsEnable_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := testClient(t).Post(srv.URL+"/api/repos/rebase-bots/enable", "application/json", strings.NewReader(`{"forge":"github","fullName":"alrayyes/forge-dashboard"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRebaseBotsEnable_InvalidFullName_Returns400(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	resp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/enable", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestRebaseBotsEnable_ThenDashboard_ReportsRebaseBotsTrue(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	enableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/enable", "alrayyes/forge-dashboard")
	defer func() { _ = enableResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, enableResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, true, repo["rebaseBots"])
	assert.Equal(t, false, repo["autoUpdateBranch"], "the two switches are independent")
}

func TestRebaseBotsEnable_NotEnabled_ReportsRebaseBotsFalse(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, false, repo["rebaseBots"])
}

func TestRebaseBotsDisable_RemovesIt(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	enableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/enable", "alrayyes/forge-dashboard")
	defer func() { _ = enableResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, enableResp.StatusCode)

	disableResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/disable", "alrayyes/forge-dashboard")
	defer func() { _ = disableResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, disableResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, false, repo["rebaseBots"])
}

func TestRebaseBotsDisable_NeverEnabled_IsANoOp(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	resp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/disable", "alrayyes/forge-dashboard")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestRebaseBotsEnable_Twice_IsNotAnError(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	first := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/enable", "alrayyes/forge-dashboard")
	defer func() { _ = first.Body.Close() }()
	require.Equal(t, http.StatusNoContent, first.StatusCode)

	second := postRepoAction(t, srvURL, sessionCookie, "/api/repos/rebase-bots/enable", "alrayyes/forge-dashboard")
	defer func() { _ = second.Body.Close() }()
	assert.Equal(t, http.StatusNoContent, second.StatusCode)
}
