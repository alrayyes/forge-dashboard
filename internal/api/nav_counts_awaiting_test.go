package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request whose workflows are held for approval reads as failing but
// isn't: nothing has failed, someone has to approve. The badge leaves it out of
// Failed, still counts it in the total, and keeps a really failed one failed.
func TestBuildNavCounts_HeldForApprovalIsNotFailed(t *testing.T) {
	t.Parallel()

	var held, mixed, failed pullRequestView
	held.CI, held.AwaitingWorkflowApproval, held.FailingOnlyForApproval = dashboard.CIFailure, true, true
	// A failed job beside a held run: the flag is set, but a job really failed.
	mixed.CI, mixed.AwaitingWorkflowApproval = dashboard.CIFailure, true
	failed.CI = dashboard.CIFailure

	counts := buildNavCounts([]pullRequestView{held, mixed, failed}, 0, nil)

	assert.Equal(t, 3, counts.PullRequests.Total)
	assert.Equal(t, 2, counts.PullRequests.Failed)
	assert.Equal(t, 0, counts.PullRequests.Running)
	assert.Equal(t, 0, counts.PullRequests.Passed)
}

// #2024: a default branch whose runs are held for approval shows in the
// Branches badge as its own count, so the pill's parts add up to its total.
func TestBuildNavCounts_ABranchHeldForApprovalIsCountedOnItsOwn(t *testing.T) {
	t.Parallel()

	branches := []dashboard.MainBranch{
		{Status: dashboard.MainBranchPassed},
		{Status: dashboard.MainBranchRunning},
		{Status: dashboard.MainBranchAwaitingApproval},
	}

	counts := buildNavCounts(nil, 0, branches)

	assert.Equal(t, 3, counts.Branches.Total)
	assert.Equal(t, 1, counts.Branches.AwaitingApproval)
	assert.Equal(t, 0, counts.Branches.None)
}
