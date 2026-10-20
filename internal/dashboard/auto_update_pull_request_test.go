package dashboard_test

import (
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request's own choice about automatic branch updates overrides its
// repo's setting, in both directions.

func behindPRsOn(repo string, numbers ...int) fakeSource {
	prs := make([]dashboard.PullRequest, 0, len(numbers))
	for _, n := range numbers {
		prs = append(prs, dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: repo, Number: n, Behind: true})
	}

	return fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: prs,
	}}
}

func TestAggregator_Refresh_PROptedOutOnEnabledRepo_IsLeftAlone_OthersStillUpdate(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn("alrayyes/a", 1, 2)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": false},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#2"}, src.updatedBranches())
}

func TestAggregator_Refresh_PROptedInOnRepoNotEnabled_IsUpdated_OthersAreNot(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn("alrayyes/a", 1, 2)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{},
		overrides: map[string]bool{"github/alrayyes/a#2": true},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
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
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
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
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_OverridesUnreadable_FallsBackToTheRepoSetting(t *testing.T) {
	t.Parallel()
	src := &fakeBranchUpdaterSource{fakeSource: behindPRsOn("alrayyes/a", 1)}
	lister := &fakeAutoUpdateBranchLister{
		enabled:      map[string]struct{}{"github/alrayyes/a": {}},
		overridesErr: errors.New("database is locked"),
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}
