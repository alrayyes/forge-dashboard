package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A job whose needs failed never starts: Forgejo leaves it blocked in a run
// that has already failed. On a default branch that is no wait, or the failed
// pill draws as still running, as a pull request's did (#3030, #3033).

func readBranchChecks(t *testing.T, runStatus string, jobs []map[string]any) dashboard.CheckCounts {
	t.Helper()
	s := &mainBranchServer{
		runs: []map[string]any{actionRun(1, "main", "cafef00d", runStatus, started, stopped)},
		jobs: map[string][]map[string]any{"1": jobs},
	}

	row, err := s.start(t).ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)

	return row.Checks
}

func TestReadMainBranch_JobsBlockedInAFailedRunAreNotWaiting(t *testing.T) {
	t.Parallel()

	got := readBranchChecks(t, "failure", jobsOf("success", "failure", "blocked", "blocked"))

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got)
}

func TestReadMainBranch_JobsBlockedInARunStillGoingStayWaiting(t *testing.T) {
	t.Parallel()

	got := readBranchChecks(t, "running", jobsOf("success", "running", "blocked", "waiting"))

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Running: 1, Waiting: 2}, got)
}

// A failed run's job that is queued, not blocked, still has a runner coming.
func TestReadMainBranch_AWaitingJobInAFailedRunStaysWaiting(t *testing.T) {
	t.Parallel()

	got := readBranchChecks(t, "failure", jobsOf("failure", "waiting"))

	assert.Equal(t, dashboard.CheckCounts{Failed: 1, Waiting: 1}, got)
}
