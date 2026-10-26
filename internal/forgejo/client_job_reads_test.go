package forgejo_test

import (
	"fmt"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// successes is n jobs that passed.
func successes(n int) []string {
	states := make([]string, n)
	for i := range states {
		states[i] = "success"
	}

	return states
}

// A forge that ignores the page parameter answers the first page again, so the
// jobs past it were never read. That list isn't final and must not be kept, or
// every later poll would be served the part we saw.
func TestListOpenPullRequests_AListFromAForgeThatIgnoresPagingIsNotKept(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.jobs[12] = successes(60)
	f.jobNames = map[int][]string{12: {"other"}} // not where the status says: the whole run is read
	f.ignorePaging = true
	s := f.serve(t)

	s.pullRequest(t)
	s.pullRequest(t)

	// The first poll reads the status's page, then the walk's two: the first
	// and the repeat that ends it. The second poll has the page kept, and walks
	// again as the list was not.
	assert.EqualValues(t, 5, s.jobReads.Load())
}

// The status says where its job is, so only the page holding that position is
// read.
func TestListOpenPullRequests_OnlyThePageHoldingTheStatusJobIsRead(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	states := successes(120)
	states[105] = "cancelled"
	f.jobs[12] = states
	f.statuses[1] = jobStatus("failure", "pr-title / shard-105 (pull_request_target)", 2, 105)
	s := f.serve(t)

	got := s.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
	assert.EqualValues(t, 1, s.jobReads.Load())
}

// The job at the position is not the one the status names: the rest of the run
// is read to look for it by name.
func TestListOpenPullRequests_AJobNotAtItsPositionIsFoundByName(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "pr-title / lint (pull_request_target)", 2, 0)
	f.jobs[12] = []string{"success", "cancelled"}
	f.jobNames = map[int][]string{12: {"check", "lint"}}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
}

// Two jobs of one name leave the status unexcused: nothing says which it is.
func TestListOpenPullRequests_ANameThatTwoJobsShareExcusesNothing(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "pr-title / lint (pull_request_target)", 2, 0)
	f.jobs[12] = []string{"success", "cancelled", "failure"}
	f.jobNames = map[int][]string{12: {"check", "lint", "lint"}}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// A run past the walk's limit still gives the jobs read so far, rather than
// none: its running job is counted.
func TestListOpenPullRequests_ARunWithOverAThousandJobsStillCountsItsFirstPage(t *testing.T) {
	t.Parallel()
	states := make([]string, 1100)
	for i := range states {
		states[i] = "waiting"
	}
	states[0] = "running"
	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / test (pull_request)", 1, 0)},
		runs:     []map[string]any{actionsRun(11, 1, "running", map[string]any{"stopped": "0001-01-01T00:00:00Z"})},
		jobs:     map[int][]string{11: states},
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Running: 1}, got.Checks, fmt.Sprint(got.Checks))
}
