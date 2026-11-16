package github_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A default branch carries how many of its checks passed, are running, are
// waiting and failed, from the per-state counts of the rollup the query
// already reads for the status, so a branch and a pull request on the same
// commit say the same thing and nothing more is fetched.
func TestFetch_MainBranch_CarriesTheCheckCounts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		rollup map[string]any
		want   dashboard.CheckCounts
	}{
		{
			name:   "a failed pipeline with checks still going",
			rollup: rollupOf("FAILURE", map[string]int{"SUCCESS": 4, "SKIPPED": 1, "IN_PROGRESS": 2, "QUEUED": 3, "FAILURE": 1, "TIMED_OUT": 1}),
			want:   dashboard.CheckCounts{Passed: 5, Skipped: 1, Running: 2, Waiting: 3, Failed: 2},
		},
		{
			name:   "a pipeline where every check was skipped",
			rollup: rollupOf("SUCCESS", map[string]int{"SKIPPED": 3}),
			want:   dashboard.CheckCounts{Passed: 3, Skipped: 3},
		},
		{
			name:   "a passed pipeline",
			rollup: rollupOf("SUCCESS", map[string]int{"SUCCESS": 11, "NEUTRAL": 1}),
			want:   dashboard.CheckCounts{Passed: 12},
		},
		{
			name:   "a cancelled run beside one still going has its own count",
			rollup: rollupOf("FAILURE", map[string]int{"SUCCESS": 2, "CANCELLED": 1, "IN_PROGRESS": 1}),
			want:   dashboard.CheckCounts{Passed: 2, Running: 1, Cancelled: 1},
		},
		{
			name:   "a failing rollup whose only trouble is a cancelled run counts it as cancelled",
			rollup: rollupOf("FAILURE", map[string]int{"SUCCESS": 2, "CANCELLED": 1}),
			want:   dashboard.CheckCounts{Passed: 2, Cancelled: 1},
		},
		{
			name:   "a failing rollup held by a run awaiting approval counts it as held",
			rollup: rollupOf("FAILURE", map[string]int{"SUCCESS": 4, "ACTION_REQUIRED": 1}),
			want:   dashboard.CheckCounts{Passed: 4, Held: 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			row, _ := tokenFetchWith(t, branchRef(tt.rollup))

			assert.Equal(t, tt.want, row.Checks)
		})
	}

	t.Run("a branch that is cancelled, not failed, has no failed count and counts the cancelled run", func(t *testing.T) {
		t.Parallel()

		row, _ := tokenFetchWith(t, branchRef(rollupOf("FAILURE", map[string]int{"SUCCESS": 2, "CANCELLED": 1},
			checkRun("lint", "SUCCESS", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z"),
			checkRun("secrets", "CANCELLED", "2026-10-10T09:01:00Z", "2026-10-10T09:01:05Z"),
		)))

		assert.Equal(t, dashboard.MainBranchCancelled, row.Status)
		assert.Equal(t, dashboard.CheckCounts{Passed: 2, Cancelled: 1}, row.Checks)
	})

	t.Run("a held run is what failed, and the cancelled runs beside it are counted apart", func(t *testing.T) {
		t.Parallel()

		row, _ := tokenFetchWith(t, branchRef(rollupOf("FAILURE", map[string]int{"ACTION_REQUIRED": 1, "CANCELLED": 2},
			checkRun("deploy", "ACTION_REQUIRED", "2026-10-10T09:01:00Z", "2026-10-10T09:01:05Z"),
		)))

		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"deploy"}, row.FailingJobs)
		assert.Equal(t, dashboard.CheckCounts{Held: 1, Cancelled: 2}, row.Checks)
	})

	t.Run("a passed branch never gains a failed count, and counts the held run", func(t *testing.T) {
		t.Parallel()

		row, _ := tokenFetchWith(t, branchRef(rollupOf("SUCCESS", map[string]int{"SUCCESS": 3, "ACTION_REQUIRED": 1})))

		assert.Equal(t, dashboard.MainBranchPassed, row.Status)
		assert.Equal(t, dashboard.CheckCounts{Passed: 3, Held: 1}, row.Checks)
	})

	t.Run("a commit nothing ran on has all zero", func(t *testing.T) {
		t.Parallel()

		row, _ := tokenFetchWith(t, branchRef(nil))

		assert.Equal(t, dashboard.CheckCounts{}, row.Checks)
	})
}

// A job nobody can grade is not a pass, so a branch that would read passed
// does not while one is present.
func TestFetch_MainBranch_AnUnknownCheckIsNotAPass(t *testing.T) {
	t.Parallel()

	row, _ := tokenFetchWith(t, branchRef(rollupOf("SUCCESS", map[string]int{"SUCCESS": 2, "BRAND_NEW": 1})))

	assert.Equal(t, dashboard.MainBranchRunning, row.Status)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2, Unknown: 1}, row.Checks)
}
