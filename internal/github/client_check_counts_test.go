package github_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request carries how many of its checks passed, are running, are
// waiting and failed, read from the per-state counts the rollup already holds,
// so the Running pill can say how far a pipeline is without another request.
func TestFetch_RollupCheckCounts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		rollup map[string]any
		want   dashboard.CheckCounts
	}{
		{
			name:   "passed, running and waiting runs",
			rollup: rollupFixture("PENDING", map[string]int{"SUCCESS": 5, "IN_PROGRESS": 2, "QUEUED": 3}, nil),
			want:   dashboard.CheckCounts{Passed: 5, Running: 2, Waiting: 3},
		},
		{
			name:   "neutral and skipped runs count as passed",
			rollup: rollupFixture("SUCCESS", map[string]int{"SUCCESS": 2, "NEUTRAL": 1, "SKIPPED": 4}, nil),
			want:   dashboard.CheckCounts{Passed: 7},
		},
		{
			name:   "every not-started state counts as waiting",
			rollup: rollupFixture("PENDING", map[string]int{"QUEUED": 1, "PENDING": 1, "WAITING": 1, "REQUESTED": 1}, nil),
			want:   dashboard.CheckCounts{Waiting: 4},
		},
		{
			name: "every bad end state counts as failed",
			rollup: rollupFixture("FAILURE", map[string]int{
				"FAILURE": 1, "TIMED_OUT": 1, "STARTUP_FAILURE": 1, "STALE": 1, "CANCELLED": 1,
			}, nil),
			want: dashboard.CheckCounts{Failed: 5},
		},
		{
			name:   "a run held for approval is none of the four",
			rollup: rollupFixture("FAILURE", map[string]int{"ACTION_REQUIRED": 3, "SUCCESS": 1}, nil),
			want:   dashboard.CheckCounts{Passed: 1},
		},
		{
			name:   "status contexts are counted beside the runs",
			rollup: rollupFixture("PENDING", map[string]int{"SUCCESS": 1}, map[string]int{"SUCCESS": 2, "PENDING": 1, "EXPECTED": 1, "FAILURE": 1, "ERROR": 1}),
			want:   dashboard.CheckCounts{Passed: 3, Waiting: 2, Failed: 2},
		},
		{
			name:   "zero counts add nothing",
			rollup: rollupFixture("SUCCESS", map[string]int{"SUCCESS": 4, "FAILURE": 0, "IN_PROGRESS": 0}, nil),
			want:   dashboard.CheckCounts{Passed: 4},
		},
		{
			name:   "no rollup means no checks",
			rollup: nil,
			want:   dashboard.CheckCounts{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tt.want, pullRequestFromGraphQLRollup(t, tt.rollup).Checks)
		})
	}
}
