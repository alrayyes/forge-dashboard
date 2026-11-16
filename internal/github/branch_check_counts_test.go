package github

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func rollupOf(runs map[string]int) *statusCheckRollup {
	r := &statusCheckRollup{}
	r.Contexts = &struct {
		CheckRunCountsByState      []stateCount    `json:"checkRunCountsByState"`
		StatusContextCountsByState []stateCount    `json:"statusContextCountsByState"`
		Nodes                      []branchContext `json:"nodes"`
	}{}
	for state, n := range runs {
		r.Contexts.CheckRunCountsByState = append(r.Contexts.CheckRunCountsByState, stateCount{State: state, Count: n})
	}

	return r
}

// A default branch counts every job its pipeline lists, so the numbers add up:
// cancelled and held jobs have counts of their own beside the four.
func TestBranchCheckCountsAddUp(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		runs   map[string]int
		status dashboard.MainBranchStatus
		want   dashboard.CheckCounts
	}{
		{
			name:   "passed jobs beside a cancelled one",
			runs:   map[string]int{"SUCCESS": 3, "CANCELLED": 1},
			status: dashboard.MainBranchCancelled,
			want:   dashboard.CheckCounts{Passed: 3, Cancelled: 1},
		},
		{
			name:   "a failure beside a cancelled job and a held one",
			runs:   map[string]int{"SUCCESS": 1, "FAILURE": 1, "CANCELLED": 1, "ACTION_REQUIRED": 1},
			status: dashboard.MainBranchFailed,
			want:   dashboard.CheckCounts{Passed: 1, Failed: 1, Cancelled: 1, Held: 1},
		},
		{
			name:   "a job held for approval",
			runs:   map[string]int{"SUCCESS": 2, "ACTION_REQUIRED": 1},
			status: dashboard.MainBranchAwaitingApproval,
			want:   dashboard.CheckCounts{Passed: 2, Held: 1},
		},
		{
			name:   "a job nobody can grade",
			runs:   map[string]int{"SUCCESS": 2, "BRAND_NEW": 1},
			status: dashboard.MainBranchRunning,
			want:   dashboard.CheckCounts{Passed: 2, Unknown: 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, branchCheckCounts(rollupOf(tt.runs), tt.status))
		})
	}
}
