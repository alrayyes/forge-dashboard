package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMCP_ListQueuedActions_ListsTheTool(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, sessionCookie))

	result, err := session.ListTools(t.Context(), nil)
	require.NoError(t, err)

	var found *mcp.Tool
	for _, tool := range result.Tools {
		if tool.Name == "list_queued_actions" {
			found = tool
		}
	}
	require.NotNil(t, found)
	for _, want := range []string{"Read-only", "queued", "rate-limited", "24 hours", "no forge budget"} {
		assert.Contains(t, found.Description, want)
	}
}

func TestMCP_ListQueuedActions_ReturnsTheSameItemsAsTheHTTPEndpoint(t *testing.T) {
	t.Parallel()

	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	status, _ := queueUpdate(t, srv, cookie, 5)
	require.Equal(t, http.StatusCreated, status)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "list_queued_actions"})
	require.NoError(t, err)
	require.False(t, result.IsError)

	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	items, err := json.Marshal(content["queuedActions"])
	require.NoError(t, err)
	httpItems, err := json.Marshal(listQueued(t, srv, cookie))
	require.NoError(t, err)
	assert.JSONEq(t, string(httpItems), string(items))
	assert.Len(t, content["queuedActions"], 1)
}

func TestMCP_ListQueuedActions_IsAnEmptyArrayWhenNothingIsQueued(t *testing.T) {
	t.Parallel()

	srv, _, cookie := queueBoard(t, false, time.Time{})
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "list_queued_actions"})
	require.NoError(t, err)
	require.False(t, result.IsError)

	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, []any{}, content["queuedActions"])
}
