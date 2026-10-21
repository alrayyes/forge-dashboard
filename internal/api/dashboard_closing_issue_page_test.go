package api_test

import (
	"strconv"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A pull request lists the issues it will close, each with the address on
// this dashboard that opens the Issues page with that issue's pop-up open.
func TestDashboard_ClosingIssuesCarryTheAddressThatOpensThem(t *testing.T) {
	t.Parallel()

	srvURL, cookie := linkedServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "?includeDrafts=true")

	pageURLs := map[string]string{}
	for _, raw := range body["pullRequests"].([]any) {
		pr := raw.(map[string]any)
		closes, ok := pr["closesIssues"].([]any)
		require.True(t, ok, "closesIssues is a list")
		for _, c := range closes {
			entry := c.(map[string]any)
			pageURLs[pr["forge"].(string)+":"+pr["repo"].(string)+"#"+strconv.Itoa(int(pr["number"].(float64)))] = entry["pageUrl"].(string)
		}
	}

	assert.Equal(t, "/issues.html?issue=github/alrayyes/a/1", pageURLs["github:alrayyes/a#20"])
	assert.Equal(t, "/issues.html?issue=forgejo/ryan/hush/3", pageURLs["forgejo:Ryan/Hush#7"],
		"the issue's repo as the closing keyword wrote it, on the pull request's own forge")
}
