package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every pull request carries the actions it allows (#805), so a client needs
// no copy of the page's rules. draftsServer's pull requests have no merge
// status yet, so Merge is offered but blocked, and Close is always there.
func TestDashboard_PullRequestsCarryTheirAllowedActions(t *testing.T) {
	t.Parallel()

	srvURL, cookie := draftsServer(t)

	snap := fetchDashboardWith(t, srvURL, cookie, "")

	prs, ok := snap["pullRequests"].([]any)
	require.True(t, ok)
	require.NotEmpty(t, prs)
	first, ok := prs[0].(map[string]any)
	require.True(t, ok)
	actions, ok := first["allowedActions"].([]any)
	require.True(t, ok, "allowedActions is always present")
	byAction := map[string]map[string]any{}
	for _, a := range actions {
		entry := a.(map[string]any)
		byAction[entry["action"].(string)] = entry
	}
	assert.Contains(t, byAction, "close")
	assert.NotContains(t, byAction["close"], "blocked")
	require.Contains(t, byAction, "merge")
	blocked, ok := byAction["merge"]["blocked"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "not_mergeable", blocked["code"])
}
