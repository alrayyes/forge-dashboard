package dashboard_test

import (
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request's own choice about automatic branch updates overrides its
// repo's setting, in both directions.

func behindPRsOn(numbers ...int) fakeSource {
	prs := make([]dashboard.PullRequest, 0, len(numbers))
	for _, n := range numbers {
		prs = append(prs, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: n, Behind: true})
	}

	return fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}}
}

func TestAggregator_Refresh_PROptedOutOnEnabledRepo_IsLeftAlone_OthersStillUpdate(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn(1, 2)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": false},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#2"}, src.updatedBranches())
}

func TestAggregator_Refresh_PROptedInOnRepoNotEnabled_IsUpdated_OthersAreNot(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn(1, 2)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{},
		overrides: map[string]bool{"github/alrayyes/a#2": true},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#2"}, src.updatedBranches())
}

func TestAggregator_Refresh_DraftOptedIn_IsStillLeftAlone(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Draft: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_ReleasePleasePROptedIn_IsStillLeftAlone(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Labels: []dashboard.Label{{Name: "autorelease: pending"}}},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_OverridesUnreadable_FallsBackToTheRepoSetting(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn(1)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:      map[string]struct{}{"github/alrayyes/a": {}},
		overridesErr: errors.New("database is locked"),
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}

// The cleanup runs in the pass, where the aggregator first sees a pull request
// gone, so a close and reopen between two dashboard loads can't keep a choice.

func reachableGitHub(prs ...dashboard.PullRequest) fakeSource {
	return fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}}
}

func TestAggregator_Refresh_ForgetsTheChoiceOfAPullRequestThatIsGone(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: reachableGitHub(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2})}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true, "github/alrayyes/a#2": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"github/alrayyes/a#1"}, lister.forgotten)
}

func TestAggregator_Refresh_ForgetsTheChoiceOfARepoNoLongerTracked(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: reachableGitHub(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2})}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/old-name#9": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"github/alrayyes/old-name#9"}, lister.forgotten)
}

func TestAggregator_Refresh_FirstRefreshWithARepoListFailed_KeepsThatRepoChoices(t *testing.T) {
	t.Parallel()
	// No earlier snapshot exists, so nothing is carried over for the repo whose
	// pull request list failed: its pull requests are simply missing.
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"}},
		FailedRepos: []dashboard.FailedRepo{{FullName: "alrayyes/a", PullRequests: true}},
	}}}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, lister.forgotten, "a list that failed is not an empty one")
}

func TestAggregator_Refresh_OneRepoListFailed_KeepsItsChoices_ButStillForgetsTheOthers(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos: []dashboard.Repo{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/b"},
		},
		FailedRepos: []dashboard.FailedRepo{{FullName: "alrayyes/a", PullRequests: true}},
	}}}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true, "github/alrayyes/b#9": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"github/alrayyes/b#9"}, lister.forgotten)
}

func TestAggregator_Refresh_ForgeUnreachable_KeepsEveryChoice(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false},
	}}}
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Empty(t, lister.forgotten, "an outage returns no pull requests, and that isn't a close")
}

func TestAggregator_Refresh_ForgetsAChoiceThatNowEqualsItsRepo(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: reachableGitHub(
		dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1},
		dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2},
	)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": true, "github/alrayyes/a#2": false},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch(lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"github/alrayyes/a#1"}, lister.forgotten, "only the one equal to the repo's new setting")
}
