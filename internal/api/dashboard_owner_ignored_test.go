package api_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const testOtherUser = "alex"

// An old client may still send ?owner=. The parameter is gone, so it is
// ignored: the caller gets their own dashboard, never another user's.
func TestDashboard_WithOwnerQuery_IsIgnoredAndTheCallerSeesTheirOwn(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-owner-token" // #nosec G101 -- a fake test fixture, not a real credential
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 9}}}
	}

	srv := newTestServerWithSources(t, buildSources)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createInviteViaAdmin(t, srv, ownerCookie, testOtherUser, "Alex")
	otherCookie, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+secretToken+`"}`, ownerCookie)
	require.Equal(t, http.StatusOK, status)

	board := fetchDashboardWith(t, srv.URL, otherCookie, "?owner="+testUser)

	assert.Empty(t, board["forges"], "the other user has saved nothing, so there is nothing to show")
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
