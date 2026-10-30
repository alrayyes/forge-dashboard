package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMCP_GetVersion_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "get_version" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "version", "no forge budget"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_GetVersion_ReturnsTheSamePayloadAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_version"})
	require.NoError(t, err)
	require.False(t, result.IsError)

	resp, err := testClient(t).Get(srv.URL + "/api/version")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var httpBody map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&httpBody))

	assert.Equal(t, testVersion, httpBody["version"])
	assert.Equal(t, httpBody, result.StructuredContent)
}

func TestMCP_GetVersion_NeedsAValidAPIToken(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/mcp", nil)
	require.NoError(t, err)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
