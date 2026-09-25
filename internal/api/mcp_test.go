package api_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// bearerRoundTripper adds an Authorization: Bearer header to every
// request it makes -- the same personal-API-token auth
// TestTokenCreated_AuthenticatesAsBearerAgainstARealEndpoint already
// proves against a plain /api/* handler, here driving an MCP client
// instead of http.DefaultClient directly.
type bearerRoundTripper struct {
	token string
	base  http.RoundTripper
}

func (rt bearerRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("Authorization", "Bearer "+rt.token)

	resp, err := rt.base.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("bearer round trip: %w", err)
	}

	return resp, nil
}

// createAPIToken registers no user of its own -- it expects sessionCookie
// from an already-registered one (registerViaRealCeremony) -- and returns
// a fresh personal API token via the same /api/tokens endpoint
// settings.html's own UI drives.
func createAPIToken(t *testing.T, srvURL string, sessionCookie *http.Cookie) string {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/tokens", strings.NewReader(tokenCreateBody("mcp client")))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusCreated, resp.StatusCode)

	var created struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&created))

	return created.Token
}

// connectMCP dials srvURL's own /api/mcp Streamable HTTP endpoint,
// authenticated as token -- the same transport and auth shape a real
// MCP-capable agent would use, not an in-process shortcut.
func connectMCP(t *testing.T, srvURL, token string) *mcp.ClientSession {
	t.Helper()

	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.0"}, nil)
	transport := &mcp.StreamableClientTransport{
		Endpoint:   srvURL + "/api/mcp",
		HTTPClient: &http.Client{Transport: bearerRoundTripper{token: token, base: http.DefaultTransport}},
	}
	session, err := client.Connect(t.Context(), transport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	return session
}

func TestMCP_GetDashboard_RequiresAuth(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.0"}, nil)
	transport := &mcp.StreamableClientTransport{Endpoint: srv.URL + "/api/mcp"}

	_, err := client.Connect(t.Context(), transport, nil)

	require.Error(t, err, "connecting with no Authorization header should be refused the same way an unauthenticated /api/dashboard request is")
}

func TestMCP_GetDashboard_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createAPIToken(t, srv.URL, sessionCookie)

	session := connectMCP(t, srv.URL, token)
	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var names []string
	for _, tool := range result.Tools {
		names = append(names, tool.Name)
	}
	assert.Contains(t, names, "get_dashboard")
}

func TestMCP_GetDashboard_ReturnsTheSameAggregatedDataAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	const secretToken = "sekrit-mcp-token" // #nosec G101 -- a fake test fixture, not a real credential
	wantHealth := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 4}

	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: wantHealth}}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createAPIToken(t, srv.URL, sessionCookie)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	session := connectMCP(t, srv.URL, token)

	var forges []any
	require.Eventually(t, func() bool {
		result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_dashboard"})
		if err != nil || result.IsError {
			return false
		}
		content, ok := result.StructuredContent.(map[string]any)
		if !ok {
			return false
		}
		forges, ok = content["forges"].([]any)

		return ok && len(forges) == 1
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture source")

	forge := forges[0].(map[string]any)
	assert.Equal(t, "github", forge["forge"])
	assert.Equal(t, true, forge["reachable"])
	assert.EqualValues(t, 4, forge["repoCount"])
}

func TestMCP_GetDashboard_UnsharedOwner_ReturnsAToolError(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	ownerCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay) // bootstraps as admin
	inviteToken := createInviteViaAdmin(t, srv, ownerCookie, testOtherUser, "Alex")
	viewerCookie, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", inviteToken)
	apiToken := createAPIToken(t, srv.URL, viewerCookie)

	session := connectMCP(t, srv.URL, apiToken)
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_dashboard",
		Arguments: map[string]any{"owner": testUser},
	})
	require.NoError(t, err)

	assert.True(t, result.IsError, "an unshared owner should come back as a tool-level error, the same Forbidden case /api/dashboard?owner= already handles")
}
