package api_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The pipeline dialog lists each workflow's newest run only, so an older failed
// run doesn't sit beside the newer one that passed.
func TestMCP_GetMainBranchChecks_ListsTheNewestRunOfEachWorkflow(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{
		forge: dashboard.ForgeGitHub,
		checks: []dashboard.Check{
			{Name: "reports", State: dashboard.CheckFailure, RunID: 10, RunName: "ci", RunNumber: 1, RunAttempt: 1},
			{Name: "reports", State: dashboard.CheckSuccess, RunID: 20, RunName: "ci", RunNumber: 2, RunAttempt: 1},
			{Name: "scan", State: dashboard.CheckSuccess, RunID: 30, RunName: "gitleaks", RunNumber: 1, RunAttempt: 1},
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

	checks := result.StructuredContent.(map[string]any)["checks"].([]any)
	var runs []any
	for _, c := range checks {
		runs = append(runs, c.(map[string]any)["runId"])
	}
	assert.Equal(t, []any{float64(20), float64(30)}, runs)
}
