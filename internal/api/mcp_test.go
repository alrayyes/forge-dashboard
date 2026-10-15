package api_test

import (
	"encoding/json"
	"errors"
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

// callMainBranchesTool calls get_main_branches until it lists want rows and
// returns what the tool answered.
func callMainBranchesTool(t *testing.T, srvURL string, cookie *http.Cookie, want int) map[string]any {
	t.Helper()

	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	var content map[string]any
	require.Eventually(t, func() bool {
		result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_main_branches"})
		if err != nil || result.IsError {
			return false
		}
		got, ok := result.StructuredContent.(map[string]any)
		if !ok {
			return false
		}
		content = got
		branches, _ := got["branches"].([]any)

		return len(branches) == want
	}, 2*time.Second, 10*time.Millisecond)

	return content
}

func TestMCP_GetMainBranches_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_main_branches" {
			found = tool
		}
	}
	require.NotNil(t, found)
	assert.Contains(t, found.Description, "Read-only")
	assert.Contains(t, found.Description, "no forge")
}

func TestMCP_GetMainBranches_ReturnsTheSameJSONAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{
		branchRow("acme/fine", dashboard.MainBranchPassed),
		branchRow("acme/broken", dashboard.MainBranchFailed),
	})
	readMainBranchesFrom(t, srvURL, cookie, 2)

	toolContent := callMainBranchesTool(t, srvURL, cookie, 2)

	_, got := record(t, http.MethodGet, srvURL+"/api/main-branches", cookie)
	var httpContent map[string]any
	require.NoError(t, json.Unmarshal(got.body, &httpContent))
	// A background refresh between the two reads stamps the snapshot again, so
	// generatedAt is the one field that may differ (#1549).
	delete(httpContent, "generatedAt")
	delete(toolContent, "generatedAt")
	assert.Equal(t, httpContent, toolContent)
}

func TestMCP_GetMainBranches_LeavesOutARepoIgnoredForPullRequests(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{
		branchRow("acme/kept", dashboard.MainBranchPassed),
		branchRow("acme/ignored", dashboard.MainBranchFailed),
	})
	readMainBranchesFrom(t, srvURL, cookie, 2)
	resp := postRepoIgnoreAction(t, srvURL, cookie, "acme/ignored", true, false)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	content := callMainBranchesTool(t, srvURL, cookie, 1)

	branches := content["branches"].([]any)
	assert.Equal(t, "acme/kept", branches[0].(map[string]any)["fullName"])
	assert.EqualValues(t, 0, content["counts"].(map[string]any)["failed"])
}

// callDetailsTool calls get_pull_request_details with args on a session for
// the user cookie belongs to.
func callDetailsTool(t *testing.T, srvURL string, cookie *http.Cookie, args map[string]any) *mcp.CallToolResult {
	t.Helper()

	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_pull_request_details", Arguments: args})
	require.NoError(t, err)
	require.False(t, result.IsError)

	return result
}

func TestMCP_GetPullRequestDetails_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_pull_request_details" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "on demand", "GraphQL", "53 requests", "Markdown", "unsanitised"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetPullRequestDetails_ReturnsTheSameJSONAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, details: sampleDetails()}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	result := callDetailsTool(t, srvURL, cookie, map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 42})

	resp := getPullRequestDetails(t, srvURL, cookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()
	var httpContent map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&httpContent))
	assert.Equal(t, httpContent, result.StructuredContent)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, 42, source.lastNumber)
}

// The release notes come from the shared function, so one case is enough.
func TestMCP_GetPullRequestDetails_AListedReleasePullRequestCarriesReleaseNotes(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{
		forge: dashboard.ForgeGitHub,
		prs: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, Title: "chore(main): release 1.2.0",
			Labels: []dashboard.Label{{Name: "autorelease: pending"}},
		}},
		details: sampleDetails(),
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, cookie)["pullRequests"].([]any)

		return len(prs) == 1
	}, 2*time.Second, 10*time.Millisecond)

	result := callDetailsTool(t, srvURL, cookie, map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 7})

	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	notes, ok := content["releaseNotes"].(map[string]any)
	require.True(t, ok, "a listed release pull request carries release notes")
	assert.Equal(t, "Adds the dialog.", notes["text"])
}

func TestMCP_GetPullRequestDetails_RefusesBadInput(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, details: sampleDetails()}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	for name, args := range map[string]map[string]any{
		"unknown forge":      {"forge": "gitlab", "fullName": "a/b", "number": 1},
		"malformed fullName": {"forge": "github", "fullName": "nope", "number": 1},
		"number not integer": {"forge": "github", "fullName": "a/b", "number": "abc"},
		"number missing":     {"forge": "github", "fullName": "a/b"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_pull_request_details", Arguments: args})

			refused := err != nil || (result != nil && result.IsError)
			assert.True(t, refused, "the tool should refuse as the endpoint answers 400")
		})
	}
	assert.Zero(t, source.lastNumber, "nothing reached the forge")
}

func TestMCP_GetPullRequestChecks_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_pull_request_checks" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "on demand", "snapshot", "GitHub", "Forgejo", "requests"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetPullRequestChecks_ReturnsTheSameJSONAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{
		forge: dashboard.ForgeGitHub,
		checks: []dashboard.Check{
			{Name: "build", State: dashboard.CheckSuccess, URL: "https://github.com/alrayyes/tempus-fugit/runs/1"},
			{Name: "test", State: dashboard.CheckRunning, URL: "https://github.com/alrayyes/tempus-fugit/runs/2"},
		},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_pull_request_checks",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 42},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)

	resp := getPullRequestChecks(t, srvURL, cookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()
	var httpContent map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&httpContent))
	assert.Equal(t, httpContent, result.StructuredContent)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

func TestMCP_GetPullRequestChecks_RefusesBadInput(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	for name, args := range map[string]map[string]any{
		"unknown forge":      {"forge": "gitlab", "fullName": "a/b", "number": 1},
		"malformed fullName": {"forge": "github", "fullName": "nope", "number": 1},
		"number not integer": {"forge": "github", "fullName": "a/b", "number": "abc"},
		"number missing":     {"forge": "github", "fullName": "a/b"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_pull_request_checks", Arguments: args})

			refused := err != nil || (result != nil && result.IsError)
			assert.True(t, refused, "the tool should refuse as the endpoint answers 400")
		})
	}
	assert.Zero(t, source.lastNumber, "nothing reached the forge")
}

// A forge failure comes back with the message the endpoint's error body carries.
func TestMCP_GetPullRequestChecks_ForgeErrorCarriesTheEndpointsMessage(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{
		forge:     dashboard.ForgeGitHub,
		checksErr: &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("github: rate limit exceeded")},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	resp := getPullRequestChecks(t, srvURL, cookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
	var body map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_pull_request_checks",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 1},
	})
	require.NoError(t, err)
	require.True(t, result.IsError)
	require.Len(t, result.Content, 1)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok)
	assert.Equal(t, body["error"], text.Text)
}
