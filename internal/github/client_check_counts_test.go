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
			// Skipped is told apart in its own count, and stays inside passed;
			// a neutral run is passed without being skipped.
			name:   "neutral and skipped runs count as passed, skipped also on its own",
			rollup: rollupFixture("SUCCESS", map[string]int{"SUCCESS": 2, "NEUTRAL": 1, "SKIPPED": 4}, nil),
			want:   dashboard.CheckCounts{Passed: 7, Skipped: 4},
		},
		{
			name:   "a pipeline where every check was skipped is all passed and all skipped",
			rollup: rollupFixture("SUCCESS", map[string]int{"SKIPPED": 3}, nil),
			want:   dashboard.CheckCounts{Passed: 3, Skipped: 3},
		},
		{
			name:   "every not-started state counts as waiting",
			rollup: rollupFixture("PENDING", map[string]int{"QUEUED": 1, "PENDING": 1, "WAITING": 1, "REQUESTED": 1}, nil),
			want:   dashboard.CheckCounts{Waiting: 4},
		},
		{
			name: "every bad end state counts as failed",
			rollup: rollupFixture("FAILURE", map[string]int{
				"FAILURE": 1, "TIMED_OUT": 1, "STARTUP_FAILURE": 1, "STALE": 1,
			}, nil),
			want: dashboard.CheckCounts{Failed: 4},
		},
		{
			// The overall state does not read a cancelled run as a failure while
			// others still run (a push superseded it, #1950), so the pill must
			// not show a red count under Running: it counts in none of the four.
			name:   "a cancelled run is none of the four",
			rollup: rollupFixture("FAILURE", map[string]int{"CANCELLED": 2, "IN_PROGRESS": 1}, nil),
			want:   dashboard.CheckCounts{Running: 1},
		},
		{
			// GitHub reports a finished run under its conclusion, so a bare
			// COMPLETED carries no failure of its own.
			name:   "a completed run counts as passed",
			rollup: rollupFixture("SUCCESS", map[string]int{"COMPLETED": 2, "SUCCESS": 1}, nil),
			want:   dashboard.CheckCounts{Passed: 3},
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
