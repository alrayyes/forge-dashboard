package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func rebaseBotsRepo() map[string]struct{} {
	return map[string]struct{}{"github/alrayyes/a": {}}
}

func commenterSource(prs ...dashboard.PullRequest) *fakeCommenterAndUpdaterSource {
	return &fakeCommenterAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // see fakeCommenterAndUpdaterSource
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}}}}
}

func labelerSource(prs ...dashboard.PullRequest) *fakeLabelerAndUpdaterSource {
	return &fakeLabelerAndUpdaterSource{fakeBranchUpdaterSource: fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // see fakeLabelerAndUpdaterSource
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}}}}
}

func TestAggregator_Refresh_RebaseBotsOnly_BehindDependabotPR_PostsRebaseComment(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_RebaseBotsOnly_BehindRenovatePR_AddsRebaseLabel(t *testing.T) {
	t.Parallel()

	src := labelerSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "renovate"})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo(), renovateLabel: "needs-rebase"}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: needs-rebase"}, src.labels())
}

func TestAggregator_Refresh_RebaseBotsOnly_BehindHumanPR_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "alrayyes"})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_RebaseBotsOnly_BehindDraftDependabotPR_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Draft: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.comments())
}

func TestAggregator_Refresh_RebaseBotsOnly_ReleasePleasePR_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot", Labels: []dashboard.Label{{Name: "autorelease: pending"}}})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_RebaseBotsOnly_OtherRepo_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/b", Number: 1, Behind: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.comments())
}

func TestAggregator_Refresh_RebaseBotsOnly_PROverriddenOff_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{
		rebaseBots: rebaseBotsRepo(),
		overrides:  map[string]bool{"github/alrayyes/a#1": false},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.comments())
}

func TestAggregator_Refresh_RebaseBotsAndAutoUpdate_BehindDependabotPR_NeverUpdatesBranch(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{enabled: rebaseBotsRepo(), rebaseBots: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_AutoUpdateOnly_BehindDependabotPR_StillRebases(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "dependabot"})
	lister := &fakeAutoUpdateBranchLister{enabled: rebaseBotsRepo()}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1: " + dashboard.DependabotRebaseComment}, src.comments())
}

func TestAggregator_Refresh_RebaseBotsListFails_StillRunsAutoUpdate(t *testing.T) {
	t.Parallel()

	src := commenterSource(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "alrayyes"})
	lister := &fakeAutoUpdateBranchLister{enabled: rebaseBotsRepo(), rebaseBotsErr: assert.AnError}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}
