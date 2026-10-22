package api_test

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMCP_GetCheckLog_ReturnsTheSameJSONAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"a/b"}, log: dashboard.JobLog{Text: "boom\n", Truncated: true}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{
		Name:      "get_check_log",
		Arguments: map[string]any{"forge": "github", "fullName": "a/b", "jobId": 9},
	})
	require.NoError(t, err)
	require.False(t, result.IsError)

	resp := getJobLog(t, srvURL, cookie, "github", "a/b", "9")
	defer func() { _ = resp.Body.Close() }()
	var httpContent map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&httpContent))
	assert.Equal(t, httpContent, result.StructuredContent)
}

func TestMCP_GetCheckLog_DescribesItselfAsReadOnlyUntrustedText(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)
	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_check_log" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "on demand", "untrusted", "256"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetCheckLog_RefusesBadInput(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	session := connectMCP(t, srvURL, createAPIToken(t, srvURL, cookie))

	for name, args := range map[string]map[string]any{
		"malformed fullName": {"forge": "github", "fullName": "nope", "jobId": 1},
		"job id zero":        {"forge": "github", "fullName": "a/b", "jobId": 0},
		"job id missing":     {"forge": "github", "fullName": "a/b"},
	} {
		t.Run(name, func(t *testing.T) {
			result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_check_log", Arguments: args})

			assert.True(t, err != nil || (result != nil && result.IsError))
		})
	}
	assert.Empty(t, source.lastName, "nothing reached the forge")
}
