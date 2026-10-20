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
			want:   dashboard.CheckCounts{Passed: 5, Running: 2, Waiting: 3, Failed: 2},
		},
		{
			name:   "a passed pipeline",
			rollup: rollupOf("SUCCESS", map[string]int{"SUCCESS": 11, "NEUTRAL": 1}),
			want:   dashboard.CheckCounts{Passed: 12},
		},
		{
			name:   "a cancelled run is in none of the four",
			rollup: rollupOf("FAILURE", map[string]int{"SUCCESS": 2, "CANCELLED": 1}),
			want:   dashboard.CheckCounts{Passed: 2},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			row, _ := tokenFetchWith(t, branchRef(tt.rollup))

			assert.Equal(t, tt.want, row.Checks)
		})
	}

	t.Run("a commit nothing ran on has all zero", func(t *testing.T) {
		t.Parallel()

		row, _ := tokenFetchWith(t, branchRef(nil))

		assert.Equal(t, dashboard.CheckCounts{}, row.Checks)
	})
}
