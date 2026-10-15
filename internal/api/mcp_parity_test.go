package api

import (
	"context"
	"slices"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// specOperationIDs lists every operationId in api/openapi.yaml.
func specOperationIDs(t *testing.T) []string {
	t.Helper()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	var ids []string
	for _, item := range doc.Paths.Map() {
		for _, op := range item.Operations() {
			ids = append(ids, op.OperationID)
		}
	}
	slices.Sort(ids)

	return ids
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
	for id := range mcpExcluded {
		add(id, "excluded")
	}
	for _, id := range mcpPending {
		add(id, "pending")
	}

	spec := specOperationIDs(t)
	for _, id := range spec {
		assert.Contains(t, covered, id, "operation %s has no MCP tool, no exclusion and no pending entry", id)
	}
	for id := range covered {
		assert.Contains(t, spec, id, "%s is named in the MCP parity lists but is not in api/openapi.yaml", id)
	}
}

func TestMCPParity_AnExclusionSaysWhy(t *testing.T) {
	t.Parallel()

	for id, reason := range mcpExcluded {
		assert.NotEmpty(t, reason, "excluded operation %s needs a reason", id)
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
