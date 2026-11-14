package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Each forge in the dashboard answer, and in the Main branches page inside it,
// carries what that forge can do, so a client asks instead of testing the name.
func TestDashboard_ForgesCarryCapabilities(t *testing.T) {
	srv, cookie := populatedBoard(t)

	body := fetchDashboardWith(t, srv.URL, cookie, "")

	forges, _ := body["forges"].([]any)
	require.NotEmpty(t, forges)
	forge, _ := forges[0].(map[string]any)
	caps, _ := forge["capabilities"].(map[string]any)
	require.NotNil(t, caps, "the forge entry has no capabilities")
	assert.Equal(t, "GitHub", caps["label"])
	assert.Equal(t, false, caps["autoMergeHeldByApp"])
	assert.Equal(t, true, caps["dependabotCommands"])

	page, _ := body["mainBranchPage"].(map[string]any)
	pageForges, _ := page["forges"].([]any)
	require.NotEmpty(t, pageForges)
	pageForge, _ := pageForges[0].(map[string]any)
	assert.Contains(t, pageForge, "capabilities")
}
