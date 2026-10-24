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
// ignored: the caller gets the one dashboard there is.
func TestDashboard_WithOwnerQuery_IsIgnored(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-owner-token" // #nosec G101 -- a fake test fixture, not a real credential
	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 9}}}
	}

	srv := newTestServerWithSources(t, buildSources)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+secretToken+`"}`, cookie)
	require.Equal(t, http.StatusOK, status)

	require.Eventually(t, func() bool {
		forges, _ := fetchDashboardWith(t, srv.URL, cookie, "?owner="+testOtherUser)["forges"].([]any)

		return len(forges) == 1
	}, pollBudget, 10*time.Millisecond, "the dashboard should appear despite the owner query")
	board := fetchDashboardWith(t, srv.URL, cookie, "?owner="+testOtherUser)

	forges, _ := board["forges"].([]any)
	require.Len(t, forges, 1)
	assert.InDelta(t, 9, forges[0].(map[string]any)["repoCount"], 0)
}

// An agent written against the old tool may still pass owner. The tool takes
// no arguments now, so its schema refuses one rather than reading it.
func TestMCP_GetDashboard_OwnerArgument_IsRefused(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_dashboard",
		Arguments: map[string]any{"owner": testUser},
	})

	require.NoError(t, err)
	assert.True(t, result.IsError)
}
