package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// #2024: a default branch whose runs are held for approval is counted on its
// own, so the five counts plus awaiting approval add up to the total.
func TestCountMainBranches_CountsBranchesAwaitingApproval(t *testing.T) {
	t.Parallel()

	rows := []dashboard.MainBranch{
		{Status: dashboard.MainBranchPassed},
		{Status: dashboard.MainBranchRunning},
		{Status: dashboard.MainBranchAwaitingApproval},
		{Status: dashboard.MainBranchAwaitingApproval},
	}

	counts := dashboard.CountMainBranches(rows)

	assert.Equal(t, 2, counts.AwaitingApproval)
	assert.Equal(t, 0, counts.None, "a held branch is not one without a pipeline")
	assert.Equal(t, 4, counts.Total)
}
