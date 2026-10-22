package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An old client may still send ?owner=. The parameter is gone, so it is
// ignored: the caller gets their own dashboard, never another user's.
func TestDashboard_WithOwnerQuery_IsIgnoredAndTheCallerSeesTheirOwn(t *testing.T) {
	t.Parallel()

	const otherToken = "sekrit-other-token"  // #nosec G101 -- a fake test fixture, not a real credential
	const secretToken = "sekrit-owner-token" // #nosec G101 -- a fake test fixture, not a real credential
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		count := map[string]int{secretToken: 9, otherToken: 3}[c.GitHubToken]
		if count == 0 {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: count}}}
	}

	srv := newTestServerWithSources(t, buildSources)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	otherCookie := registerExtraUser(t, srv, testOtherUser, "Alex")
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+secretToken+`"}`, ownerCookie)
	require.Equal(t, http.StatusOK, status)
	status, _ = putSettings(t, srv.URL, `{"githubToken":"`+otherToken+`"}`, otherCookie)
	require.Equal(t, http.StatusOK, status)

	require.Eventually(t, func() bool {
		forges, _ := fetchDashboardWith(t, srv.URL, otherCookie, "?owner="+testUser)["forges"].([]any)

		return len(forges) == 1
	}, pollBudget, 10*time.Millisecond, "the other user's own forge should appear")
	board := fetchDashboardWith(t, srv.URL, otherCookie, "?owner="+testUser)

	forges, _ := board["forges"].([]any)
	require.Len(t, forges, 1)
	assert.InDelta(t, 3, forges[0].(map[string]any)["repoCount"], 0, "their own 3 repos, not the owner's 9")
}

// An agent written against the old tool may still pass owner. The tool takes
// no arguments now, so its schema refuses one rather than reading it.
func TestMCP_GetDashboard_OwnerArgument_IsRefused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_dashboard",
		Arguments: map[string]any{"owner": testUser},
	})

	require.NoError(t, err)
	assert.True(t, result.IsError)
}
