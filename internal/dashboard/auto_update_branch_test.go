package dashboard_test

import (
	"context"
	"strconv"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBranchUpdaterSource is fakeSource plus dashboard.BranchUpdater —
// fakeSource itself deliberately doesn't implement it (refresh_repo_test.go
// relies on that to test the "source doesn't support it" fallback), so
// auto-update-branch's own tests get their own fake instead of widening
// the shared one out from under that other test.
type fakeBranchUpdaterSource struct {
	fakeSource

	mu      sync.Mutex
	updated []string // "owner/name#number"
}

func (f *fakeBranchUpdaterSource) UpdateBranch(_ context.Context, owner, name string, number int) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updated = append(f.updated, owner+"/"+name+"#"+strconv.Itoa(number))

	return false, nil
}

func (f *fakeBranchUpdaterSource) updatedBranches() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.updated...)
}

// fakeAutoUpdateBranchLister implements dashboard.AutoUpdateBranchLister
// against a fixed, in-memory set — no real settings.Store needed to test
// the Aggregator's own use of it.
type fakeAutoUpdateBranchLister struct {
	enabled           map[string]struct{}
	allowBotPRUpdates bool
	err               error
	botErr            error
}

func (f *fakeAutoUpdateBranchLister) AutoUpdateBranchRepos(_ context.Context, _ []byte) (map[string]struct{}, error) {
	if f.err != nil {
		return nil, f.err
	}

	return f.enabled, nil
}

func (f *fakeAutoUpdateBranchLister) AllowsBotPRUpdates(_ context.Context, _ []byte) (bool, error) {
	if f.botErr != nil {
		return false, f.botErr
	}

	return f.allowBotPRUpdates, nil
}

func TestAggregator_Refresh_BehindPROnEnabledRepo_UpdatesBranch(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}

func TestAggregator_Refresh_PRNotBehind_LeavesItAlone(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: false},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_BehindPROnRepoNotEnabled_LeavesItAlone(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{enabled: map[string]struct{}{}}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_BehindBotManagedPR_SkippedUnlessAllowed(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "app/renovate"},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: false,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches(), "bot-managed and allowBotPRUpdates is false")
}

func TestAggregator_Refresh_BehindBotManagedPR_UpdatedWhenAllowed(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true, Author: "app/renovate"},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled:           map[string]struct{}{"github/alrayyes/a": {}},
		allowBotPRUpdates: true,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"alrayyes/a#1"}, src.updatedBranches())
}

func TestAggregator_Refresh_NoAutoUpdateEnabled_NeverCallsLister(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}

	// EnableAutoUpdateBranch never called — same as every Aggregator
	// before #365, and Manager's own construction when no
	// AutoUpdateBranchLister is configured.
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Empty(t, src.updatedBranches())
}

func TestAggregator_Refresh_ListerErrors_RefreshStillSucceeds(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
	}}
	lister := &fakeAutoUpdateBranchLister{err: assert.AnError}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	require.NotPanics(t, func() { agg.Refresh(t.Context()) })
	assert.True(t, agg.Get().Forges[0].Reachable, "a lister failure must not corrupt the snapshot it has nothing to do with")
}

func TestAggregator_Refresh_AllowsBotPRUpdatesErrors_RefreshStillSucceeds(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
		botErr:  assert.AnError,
	}

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	require.NotPanics(t, func() { agg.Refresh(t.Context()) })
	assert.Empty(t, src.updatedBranches(), "a failure to learn the bot-pr-updates setting must not update anything it can't yet classify correctly")
	assert.True(t, agg.Get().Forges[0].Reachable)
}
