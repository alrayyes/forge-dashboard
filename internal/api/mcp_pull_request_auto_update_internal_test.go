package api

import (
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// With no user on the request the write tool fails closed with a tool error,
// before it touches any store.
func TestMCP_SetPullRequestAutoUpdate_FailsClosedWithoutAUser(t *testing.T) {
	t.Parallel()

	ctx := t.Context()
	server := newMCPServer(Deps{Version: "test"}, nil, false)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "test"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = session.Close() })

	result, err := session.CallTool(ctx, &mcp.CallToolParams{
		Name:      "set_pull_request_auto_update",
		Arguments: map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1, "enabled": false},
	})
	require.NoError(t, err)

	assert.True(t, result.IsError)
}
