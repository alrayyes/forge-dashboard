package api

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// specOperations returns every operation in api/openapi.yaml: the operationIds
// in order, and the `x-mcp-excluded` reason of those that carry one. An
// operation without an operationId, or two with the same one, fails the test
// here rather than slipping through.
func specOperations(t *testing.T) (ids []string, excluded map[string]string) {
	t.Helper()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	excluded = map[string]string{}
	seen := map[string]bool{}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			require.NotEmpty(t, op.OperationID, "%s %s has no operationId", method, path)
			require.False(t, seen[op.OperationID], "operationId %s is used twice", op.OperationID)
			seen[op.OperationID] = true
			ids = append(ids, op.OperationID)
			if raw, ok := op.Extensions["x-mcp-excluded"]; ok {
				reason, isString := raw.(string)
				require.True(t, isString, "%s: x-mcp-excluded must be a string reason", op.OperationID)
				excluded[op.OperationID] = reason
			}
		}
	}
	slices.Sort(ids)

	return ids, excluded
}

// registeredMCPTools connects an in-memory client to the server the handler
// builds and returns the names of the tools it really serves.
func registeredMCPTools(t *testing.T) []string {
	t.Helper()

	ctx := context.Background()
	server := newMCPServer(Deps{Version: "test"}, nil, false)
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "parity-test", Version: "test"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	require.NoError(t, err)
	t.Cleanup(func() { _ = clientSession.Close() })

	list, err := clientSession.ListTools(ctx, nil)
	require.NoError(t, err)
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)

	return names
}

// Every API operation is reachable through MCP, or says why it isn't, or is on
// the list of tools still to come (#1503). A new operation in the spec with
// none of the three fails here, so a capability can't ship that an agent can't
// reach.
func TestMCPParity_EveryOperationHasAToolAnExclusionOrAPendingEntry(t *testing.T) {
	t.Parallel()

	covered := map[string]string{}
	add := func(id, how string) {
		if prev, dup := covered[id]; dup {
			t.Errorf("operation %s is both %s and %s", id, prev, how)
		}
		covered[id] = how
	}
	for tool, id := range mcpToolOperations {
		add(id, "tool "+tool)
	}
	spec, excluded := specOperations(t)
	for id := range excluded {
		add(id, "excluded")
	}
	for _, id := range mcpPending {
		add(id, "pending")
	}

	for _, id := range spec {
		assert.Contains(t, covered, id, "operation %s has no MCP tool, no exclusion and no pending entry", id)
	}
	for id := range covered {
		assert.Contains(t, spec, id, "%s is named in the MCP parity lists but is not in api/openapi.yaml", id)
	}
}

func TestMCPParity_AnExclusionSaysWhy(t *testing.T) {
	t.Parallel()

	_, excluded := specOperations(t)
	assert.NotEmpty(t, excluded, "the spec marks no operation x-mcp-excluded")
	for id, reason := range excluded {
		assert.NotEmpty(t, strings.TrimSpace(reason), "x-mcp-excluded on %s needs a reason", id)
	}
}

// The tool-to-operation table has to match what the server really serves, or a
// tool could be claimed on paper.
func TestMCPParity_TheToolTableMatchesTheServedTools(t *testing.T) {
	t.Parallel()

	var claimed []string
	for tool := range mcpToolOperations {
		claimed = append(claimed, tool)
	}
	slices.Sort(claimed)

	assert.Equal(t, claimed, registeredMCPTools(t))
}
