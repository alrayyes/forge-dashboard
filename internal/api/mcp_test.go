package api_test

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
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
// instead of a bare request.
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
	resp, err := testClient(t).Do(req)
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
		HTTPClient: &http.Client{Transport: bearerRoundTripper{token: token, base: http.DefaultTransport.(*http.Transport).Clone()}},
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
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
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

	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: wantHealth}}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	token := createAPIToken(t, srv.URL, sessionCookie)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := testClient(t).Do(putReq)
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
	}, pollBudget, 10*time.Millisecond, "the background refresh should have picked up the fixture source")

	forge := forges[0].(map[string]any)
	assert.Equal(t, "github", forge["forge"])
	assert.Equal(t, true, forge["reachable"])
	assert.EqualValues(t, 4, forge["repoCount"])
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
	}, pollBudget, 10*time.Millisecond)

	return content
}

func TestMCP_GetMainBranches_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
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
	assert.Contains(t, found.Description, "advisories")
	assert.Contains(t, found.Description, "unknown")
	assert.Contains(t, found.Description, advisoriesWording)
	assert.Contains(t, found.Description, checkCountsWording)
}

// checkCountsWording is the sentence the MCP tool and the WebMCP tool use for
// a row's checks. web/src/lib/webmcp-tools.test.ts pins the same text.
const checkCountsWording = "A row's checks counts describe the same jobs get_main_branch_checks lists for that repository."

func TestMCP_GetMainBranches_ReturnsCheckCountsUnchanged(t *testing.T) {
	t.Parallel()

	busy := branchRow("acme/busy", dashboard.MainBranchRunning)
	busy.Checks = dashboard.CheckCounts{Passed: 13, Skipped: 10, Running: 1, Waiting: 3, Failed: 2}
	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{busy})

	content := callMainBranchesTool(t, srvURL, cookie, 1)

	row := content["branches"].([]any)[0].(map[string]any)
	assert.Equal(t, map[string]any{
		"passed":  float64(13),
		"skipped": float64(10),
		"running": float64(1),
		"waiting": float64(3),
		"failed":  float64(2),
	}, row["checks"])
}

// advisoriesWording is the one sentence both the MCP and the WebMCP tool use
// for the advisories field. web/src/lib/webmcp-tools.test.ts pins the same text.
const advisoriesWording = "The advisories key is absent when no source reads the repository's forge. " +
	"A state of unknown means the source could not say, never zero; a Forgejo repo " +
	"is unknown unless the operator switched lockfile checking on (reason not_enabled). " +
	"A partial: true answer left out some of the repository's packages (private ones), so its " +
	"count is a floor and a zero does not mean the repository is clean."

func TestMCP_GetMainBranches_ReturnsAdvisoriesUnchanged(t *testing.T) {
	t.Parallel()

	known := branchRow("acme/known", dashboard.MainBranchPassed)
	known.Advisories = &dashboard.Advisories{
		State:   dashboard.AdvisoriesKnown,
		Count:   3,
		Highest: dashboard.SeverityHigh,
		URL:     "https://github.com/acme/known/security/dependabot",
	}
	unknown := branchRow("acme/unknown", dashboard.MainBranchFailed)
	unknown.Advisories = &dashboard.Advisories{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonThrottled}
	none := branchRow("acme/none", dashboard.MainBranchPassed)
	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{known, unknown, none})

	content := callMainBranchesTool(t, srvURL, cookie, 3)

	byName := map[string]map[string]any{}
	for _, row := range content["branches"].([]any) {
		r := row.(map[string]any)
		byName[r["fullName"].(string)] = r
	}
	assert.Equal(t, map[string]any{
		"state":   "known",
		"count":   float64(3),
		"highest": "high",
		"url":     "https://github.com/acme/known/security/dependabot",
	}, byName["acme/known"]["advisories"])
	assert.Equal(t, "unknown", byName["acme/unknown"]["advisories"].(map[string]any)["state"])
	assert.Equal(t, "throttled", byName["acme/unknown"]["advisories"].(map[string]any)["reason"])
	assert.NotContains(t, byName["acme/none"], "advisories")
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
	// The page orders its own rows and the tool orders its own, so the two
	// agree on the rows, not on where they sit.
	byName := func(rows any) {
		sort.Slice(rows.([]any), func(i, j int) bool {
			l, r := rows.([]any)[i].(map[string]any), rows.([]any)[j].(map[string]any)

			return l["fullName"].(string) < r["fullName"].(string)
		})
	}
	byName(httpContent["branches"])
	byName(toolContent["branches"])
	assert.Equal(t, httpContent, toolContent)
}

func TestMCP_GetMainBranches_ListsNewestCommitFirstWhateverTheSnapshotOrder(t *testing.T) {
	t.Parallel()

	older := branchRow("acme/older", dashboard.MainBranchPassed)
	newer := branchRow("acme/newer", dashboard.MainBranchFailed)
	undated := branchRow("acme/undated", dashboard.MainBranchNone)
	for row, ago := range map[*dashboard.MainBranch]time.Duration{&older: 5 * time.Hour, &newer: time.Hour} {
		c := time.Now().Add(-ago).UTC()
		row.Commit = &dashboard.MainBranchCommit{CommittedAt: &c}
	}
	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{undated, older, newer})

	content := callMainBranchesTool(t, srvURL, cookie, 3)

	var order []string
	for _, row := range content["branches"].([]any) {
		order = append(order, row.(map[string]any)["fullName"].(string))
	}
	assert.Equal(t, []string{"acme/newer", "acme/older", "acme/undated"}, order)
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
	assert.Len(t, branches, 1, "the ignored repo's failing branch is left out")
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
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
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
	}, pollBudget, 10*time.Millisecond)

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

func TestMCP_GetMainBranchChecks_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_main_branch_checks" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "on demand", "snapshot", "GitHub", "Forgejo", "requests", "untrusted"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetMainBranchChecks_ReturnsTheChecks(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{
		forge: dashboard.ForgeGitHub,
		checks: []dashboard.Check{
			{Name: "build", State: dashboard.CheckSuccess, URL: "https://github.com/alrayyes/tempus-fugit/runs/1"},
		},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_main_branch_checks",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)

	assert.Equal(t, map[string]any{"checks": []any{
		map[string]any{"name": "build", "status": "completed", "conclusion": "success", "url": "https://github.com/alrayyes/tempus-fugit/runs/1"},
	}}, result.StructuredContent)
}

func TestMCP_GetMainBranchChecks_RefusesBadInput(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	for name, args := range map[string]map[string]any{
		"unknown forge":      {"forge": "gitlab", "fullName": "a/b"},
		"malformed fullName": {"forge": "github", "fullName": "nope"},
		"fullName missing":   {"forge": "github"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_main_branch_checks", Arguments: args})

			refused := err != nil || (result != nil && result.IsError)
			assert.True(t, refused, "the tool should refuse as the endpoint answers 400")
		})
	}
	assert.Empty(t, source.lastName, "nothing reached the forge")
}

func TestMCP_GetRepositoryAdvisories_RefusalCarriesTheEndpointsMessage(t *testing.T) {
	t.Parallel()

	githubSource := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub}
	forgejoSource := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	githubURL, githubCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, githubSource)
	forgejoURL, forgejoCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, forgejoSource)

	for name, tc := range map[string]struct {
		srvURL   string
		cookie   *http.Cookie
		forge    string
		fullName string
	}{
		"malformed fullName": {githubURL, githubCookie, "github", "nope"},
		"forgejo repository": {forgejoURL, forgejoCookie, "forgejo", "acme/tool"},
	} {
		t.Run(name, func(t *testing.T) {
			session := connectMCP(t, tc.srvURL, createAPIToken(t, tc.srvURL, tc.cookie))

			resp := getAdvisoryList(t, tc.srvURL, tc.cookie, tc.forge, tc.fullName)
			defer func() { _ = resp.Body.Close() }()
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			var body map[string]string
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
				Name:      "get_repository_advisories",
				Arguments: map[string]any{"forge": tc.forge, "fullName": tc.fullName},
			})
			require.NoError(t, err)
			require.True(t, result.IsError)
			require.Len(t, result.Content, 1)
			text, ok := result.Content[0].(*mcp.TextContent)
			require.True(t, ok)
			assert.Equal(t, body["error"], text.Text)
		})
	}
}

func TestMCP_GetPullRequestChecks_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
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

func TestMCP_GetPullRequestChecks_ReturnsTheChecks(t *testing.T) {
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

	assert.Equal(t, map[string]any{"checks": []any{
		map[string]any{"name": "build", "status": "completed", "conclusion": "success", "url": "https://github.com/alrayyes/tempus-fugit/runs/1"},
		map[string]any{"name": "test", "status": "in_progress", "url": "https://github.com/alrayyes/tempus-fugit/runs/2"},
	}}, result.StructuredContent)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

// Forgejo's real shape is a ForgeClient behind GenericSource. A fake Source that
// implements the checker itself never exercises that forwarding (#455).
func TestMCP_GetPullRequestChecks_ForgejoViaGenericSource_ReturnsChecks(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClientWithChecker{
		checks: []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess, URL: "https://git.example/runs/1"}},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_pull_request_checks",
		Arguments: map[string]any{"forge": "forgejo", "fullName": "alrayyes/tempus-fugit", "number": 7},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)
	assert.Equal(t, "tempus-fugit", client.lastName)
	assert.Equal(t, 7, client.lastNumber)
}

func TestMCP_GetMainBranchChecks_ForgejoViaGenericSource_ReturnsChecks(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClientWithBranchChecker{}
	client.checks = []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess, URL: "https://git.example/runs/1"}}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_main_branch_checks",
		Arguments: map[string]any{"forge": "forgejo", "fullName": "alrayyes/tempus-fugit"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)
	assert.Equal(t, "tempus-fugit", client.lastName)
}

func TestMCP_GetMainBranchChecks_NoChecks_ReturnsAnEmptyArray(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_main_branch_checks",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)
	assert.Equal(t, map[string]any{"checks": []any{}}, result.StructuredContent)
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

// A forge failure comes back with the forge's own message.
func TestMCP_GetPullRequestChecks_ForgeErrorCarriesTheForgesMessage(t *testing.T) {
	t.Parallel()

	forgeErr := &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("github: rate limit exceeded")}
	source := &fakeCheckerSource{forge: dashboard.ForgeGitHub, checksErr: forgeErr}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_pull_request_checks",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": 1},
	})
	require.NoError(t, err)
	require.True(t, result.IsError)
	require.Len(t, result.Content, 1)
	text, ok := result.Content[0].(*mcp.TextContent)
	require.True(t, ok)
	assert.Equal(t, forgeErr.Error(), text.Text)
}

func TestMCP_GetRepositoryAdvisories_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_repository_advisories" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "on demand", "snapshot", "GitHub", "unknown", "not a finding", "untrusted"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetRepositoryAdvisories_ReturnsTheSameJSONAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub, list: sampleAdvisoryList()}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_repository_advisories",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)

	resp := getAdvisoryList(t, srvURL, cookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()
	var httpContent map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&httpContent))
	assert.Equal(t, httpContent, result.StructuredContent)
}

func TestMCP_GetRepositoryAdvisories_SaysUnknownRatherThanEmpty(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{
		forge: dashboard.ForgeGitHub,
		list:  dashboard.AdvisoryList{State: dashboard.AdvisoriesUnknown, Reason: dashboard.ReasonRefused, Advisories: []dashboard.AdvisoryItem{}},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_repository_advisories",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit"},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "unknown", content["state"])
	assert.NotEmpty(t, content["reason"])
	assert.Equal(t, []any{}, content["advisories"], "an unknown list is an empty array, not null")
}

func TestMCP_GetRepositoryAdvisories_RefusesBadInput(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	for name, args := range map[string]map[string]any{
		"unknown forge":      {"forge": "gitlab", "fullName": "a/b"},
		"malformed fullName": {"forge": "github", "fullName": "nope"},
		"fullName missing":   {"forge": "github"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_repository_advisories", Arguments: args})

			refused := err != nil || (result != nil && result.IsError)
			assert.True(t, refused, "the tool should refuse as the endpoint answers 400")
		})
	}
	assert.Empty(t, source.lastName, "nothing reached the forge")
}
