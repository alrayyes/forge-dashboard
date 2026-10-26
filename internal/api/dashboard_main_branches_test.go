package api_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mainBranchNames is the repos of the dashboard payload's mainBranchPage rows.
func mainBranchNames(t *testing.T, got map[string]any) []string {
	t.Helper()
	section, ok := got["mainBranchPage"].(map[string]any)
	require.True(t, ok, "mainBranchPage is always present")
	rows, _ := section["branches"].([]any)
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row.(map[string]any)["fullName"].(string))
	}

	return names
}

// The dashboard payload, and so the stream, carries the Main branches rows, so
// the page takes them from the one message that updates every other page.
func TestDashboard_CarriesTheMainBranchRows(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{
		branchRow("acme/a", dashboard.MainBranchPassed),
		branchRow("acme/b", dashboard.MainBranchFailed),
	})

	require.Eventually(t, func() bool {
		return len(mainBranchNames(t, fetchDashboard(t, srvURL, cookie))) == 2
	}, pollBudget, 10*time.Millisecond)

	section := fetchDashboard(t, srvURL, cookie)["mainBranchPage"].(map[string]any)
	assert.NotContains(t, section, "counts", "the page tallies the rows it holds")
}

// The rows follow the same ignore list as GET /api/main-branches.
func TestDashboard_MainBranchRowsLeaveOutARepoIgnoredForPullRequests(t *testing.T) {
	t.Parallel()

	srvURL, cookie := newMainBranchesServer(t, []dashboard.MainBranch{
		branchRow("acme/kept", dashboard.MainBranchPassed),
		branchRow("acme/ignored", dashboard.MainBranchFailed),
	})
	readMainBranchesFrom(t, srvURL, cookie, 2)
	resp := postRepoIgnoreAction(t, srvURL, cookie, "acme/ignored", true, false)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.Equal(t, []string{"acme/kept"}, mainBranchNames(t, fetchDashboard(t, srvURL, cookie)))
}
