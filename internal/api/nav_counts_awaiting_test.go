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

	counts := buildNavCounts([]pullRequestView{held, mixed, failed}, 0)

	assert.Equal(t, 3, counts.PullRequests.Total)
	assert.Equal(t, 2, counts.PullRequests.Failed)
	assert.Equal(t, 0, counts.PullRequests.Running)
	assert.Equal(t, 0, counts.PullRequests.Passed)
}

// A pull request whose only trouble is a cancelled run is a part of its own:
// nothing failed, so it is not Failed, but the parts add up to the total
// (#3967).
func TestBuildNavCounts_CancelledOnlyIsItsOwnPart(t *testing.T) {
	t.Parallel()

	var cancelled pullRequestView
	cancelled.CI = dashboard.CICancelled

	counts := buildNavCounts([]pullRequestView{cancelled}, 0)

	assert.Equal(t, 1, counts.PullRequests.Total)
	assert.Equal(t, 1, counts.PullRequests.Cancelled)
	assert.Equal(t, 0, counts.PullRequests.Failed)
	assert.Equal(t, 0, counts.PullRequests.Running)
	assert.Equal(t, 0, counts.PullRequests.Passed)
	assert.Equal(t, 0, counts.PullRequests.NoChecks)
}

// A green bot pull request whose base has moved on is counted as behind, beside
// the passed count and never instead of it (#4282). Only the Bots page counts
// it: a person's pull request is the author's to bring up to date. A failing
// one, a draft and an empty one (nothing left to merge) are left out, the same
// reading the row's Out of date badge uses.
func TestBuildNavCounts_GreenBotPullRequestsBehindAreCounted(t *testing.T) {
	t.Parallel()

	bot := func(ci dashboard.CIStatus, behind, empty bool) pullRequestView {
		var v pullRequestView
		v.Kind, v.CI, v.Behind, v.Empty = dashboard.KindDependency, ci, behind, empty

		return v
	}
	person := bot(dashboard.CISuccess, true, false)
	person.Kind = dashboard.KindRegular
	draft := bot(dashboard.CISuccess, true, false)
	draft.Draft = true

	counts := buildNavCounts([]pullRequestView{
		bot(dashboard.CISuccess, true, false),
		bot(dashboard.CISuccess, true, false),
		bot(dashboard.CISuccess, false, false),
		bot(dashboard.CISuccess, true, true),
		bot(dashboard.CIFailure, true, false),
		bot(dashboard.CIPending, true, false),
		person,
		draft,
	}, 0)

	assert.Equal(t, 2, counts.Bots.Behind)
	assert.Equal(t, 4, counts.Bots.Passed, "behind is beside passed, not taken out of it")
	assert.Equal(t, 0, counts.PullRequests.Behind)
	assert.Equal(t, 0, counts.Releases.Behind)
}
