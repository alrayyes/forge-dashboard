package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Each pull request says whether it is ready to merge and whether it needs a
// review (#807), so a second client lists the same ones the page does.
func TestDashboard_PullRequestsCarryTheQuickFilterAnswers(t *testing.T) {
	t.Parallel()

	srvURL, cookie := draftsServer(t)

	snap := fetchDashboardWith(t, srvURL, cookie, "")

	prs, ok := snap["pullRequests"].([]any)
	require.True(t, ok)
	require.NotEmpty(t, prs)
	first, ok := prs[0].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, false, first["readyToMerge"], "always present, and false for a pull request with no merge status yet")
	assert.Equal(t, false, first["needsReview"])
}
