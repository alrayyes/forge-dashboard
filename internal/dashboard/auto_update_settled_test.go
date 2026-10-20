package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request the aggregator is told has merged or closed loses its own
// automatic-update choice then, so one that reopens follows its repo again.

func TestAggregator_MarkSettled_ForgetsThePullRequestsOwnUpdateChoice(t *testing.T) {
	t.Parallel()
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": false}}
	agg := dashboard.NewAggregator([]dashboard.Source{&fakeSource{}})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	agg.MarkSettled(dashboard.ForgeGitHub, "alrayyes/a", 1)

	assert.Equal(t, []string{"github/alrayyes/a#1"}, lister.forgotten)
}

func TestAggregator_MarkSettled_WithoutAutoUpdateConfigured_IsStillFine(t *testing.T) {
	t.Parallel()
	agg := dashboard.NewAggregator([]dashboard.Source{&fakeSource{}})

	assert.NotPanics(t, func() { agg.MarkSettled(dashboard.ForgeGitHub, "alrayyes/a", 1) })
}

func TestAggregator_MarkSettled_LeavesAnotherPullRequestsChoiceAlone(t *testing.T) {
	t.Parallel()
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": false, "github/alrayyes/a#2": false}}
	agg := dashboard.NewAggregator([]dashboard.Source{&fakeSource{}})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	agg.MarkSettled(dashboard.ForgeGitHub, "alrayyes/a", 1)

	assert.Equal(t, map[string]bool{"github/alrayyes/a#2": false}, lister.overrides)
}

func TestAggregator_MarkSettled_BoundsTheDelete(t *testing.T) {
	t.Parallel()
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": false}}
	agg := dashboard.NewAggregator([]dashboard.Source{&fakeSource{}})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	agg.MarkSettled(dashboard.ForgeGitHub, "alrayyes/a", 1)

	assert.True(t, lister.forgetBounded, "a stuck database must not hold the caller")
}

func TestAggregator_Refresh_AnOpenPullRequestKeepsItsChoice(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn(1)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": false},
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Empty(t, lister.forgotten)
	assert.Empty(t, src.updatedBranches(), "its choice to be left alone still holds")
}

func TestAggregator_ClosedThenReopened_FollowsTheRepoAgain(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn(1)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": false},
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.MarkSettled(dashboard.ForgeGitHub, "alrayyes/a", 1)
	agg.Unsettle(dashboard.ForgeGitHub, "alrayyes/a", 1)

	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches(), "the repo updates it again, its old choice is gone")
}
