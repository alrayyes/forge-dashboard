package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// flippingSource is a Forgejo source whose one pull request becomes
// mergeable when a test says so, with no webhook and no request to announce it.
type flippingSource struct {
	fakeAutoMergeSource

	flipMu    sync.Mutex
	mergeable bool
}

func (s *flippingSource) Fetch(ctx context.Context) dashboard.Result {
	s.flipMu.Lock()
	defer s.flipMu.Unlock()

	pr := amPR(func(p *dashboard.PullRequest) {
		if !s.mergeable {
			p.MergeStatus = dashboard.MergeUnknown
		}
	})
	s.result = dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		PullRequests: []dashboard.PullRequest{pr},
	}

	return s.fakeSource.Fetch(ctx)
}

func (s *flippingSource) flip() {
	s.flipMu.Lock()
	defer s.flipMu.Unlock()
	s.mergeable = true
}

// runIdle starts agg.Run and returns once the entry refresh is done and the
// activity, on clock, has gone idle.
func runIdle(t *testing.T, agg *dashboard.Aggregator, act *dashboard.Activity, clock *fakeClock, timer *fakeRunTimer) {
	t.Helper()

	timer.start(t, agg, 20*time.Millisecond)
	clock.advance(time.Hour)
	require.True(t, act.Idle())
}

// A pull request armed for merge whose mergeability flips later, with no
// webhook, is merged by the scheduled pass alone. Resting that pass while idle
// would stall "merge when green" until someone came back.
func TestAggregator_Run_WhileIdle_StillRefreshesForAnArmedPullRequest(t *testing.T) {
	t.Parallel()

	src := &flippingSource{}
	store := armedStore(armedKey)
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoMerge(store)

	runIdle(t, agg, act, clock, timer)
	require.Empty(t, src.mergedPullRequests(), "not mergeable yet")

	src.flip()

	timer.tick(t)
	require.Len(t, src.mergedPullRequests(), 1, "the armed pull request is merged while the dashboard is idle")
}

func TestAggregator_Run_WhileIdle_RestsWhenNothingIsArmed(t *testing.T) {
	t.Parallel()

	src := &flippingSource{}
	store := armedStore()
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoMerge(store)

	runIdle(t, agg, act, clock, timer)
	timer.tick(t)
	timer.tick(t)

	assert.Equal(t, 1, src.callCount(), "nothing is waiting on the schedule, so it rests")
}

func TestAggregator_Run_WhileIdle_StillRefreshesForABehindPullRequestNotYetUpdated(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // see auto_update_branch_test.go
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true}},
	}}}
	// Switched on after the entry refresh, as the user switching it on would be.
	lister := &switchableLister{}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch(lister)

	runIdle(t, agg, act, clock, timer)
	require.Empty(t, src.updatedBranches())

	lister.enable("github/alrayyes/a")

	timer.tick(t)
	require.NotEmpty(t, src.updatedBranches(), "a behind pull request the hook has not yet tried is updated while idle")
}

// conflictingUpdater is a source whose forge refuses every branch update with a
// conflict.
type conflictingUpdater struct {
	fakeSource
}

func (*conflictingUpdater) UpdateBranch(context.Context, string, string, int) (bool, error) {
	return false, &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("conflict")}
}

// A behind pull request the hook already tried and was refused (a conflict)
// stands for an hour, so it is no reason to keep refreshing.
func TestAggregator_Run_WhileIdle_RestsForABehindPullRequestAlreadyTried(t *testing.T) {
	t.Parallel()

	src := &conflictingUpdater{fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true}},
	}}}
	lister := &fakeAutoUpdateBranchLister{enabled: map[string]struct{}{"github/alrayyes/a": {}}}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch(lister)

	runIdle(t, agg, act, clock, timer)
	timer.tick(t)
	timer.tick(t)

	assert.Equal(t, 1, src.callCount(), "the entry refresh tried it; an attempt that stands is not a reason to refresh")
}

// switchableLister is an AutoUpdateBranchLister whose enabled set a test fills
// in while the aggregator runs.
type switchableLister struct {
	mu      sync.Mutex
	enabled map[string]struct{}
}

func (l *switchableLister) enable(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.enabled = map[string]struct{}{key: {}}
}

func (l *switchableLister) AutoUpdateBranchRepos(context.Context) (map[string]struct{}, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.enabled, nil
}

func (l *switchableLister) PullRequestAutoUpdates(context.Context) (map[string]bool, error) {
	return nil, nil
}

func (l *switchableLister) ForgetPullRequestAutoUpdates(context.Context, []string) error {
	return nil
}

func (l *switchableLister) RenovateRebaseLabel(context.Context) (string, error) {
	return "rebase", nil
}

func (l *switchableLister) RenovateAuthors(context.Context) ([]string, error) {
	return nil, nil
}

func behindSource() *fakeBranchUpdaterSource {
	return &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // see auto_update_branch_test.go
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true}},
	}}}
}

// A pull request switched on by its own choice is as much a reason to keep
// the schedule running as one whose repo is switched on.
func TestAggregator_Run_WhileIdle_StillRefreshesForAPullRequestSwitchedOnByItsOwnChoice(t *testing.T) {
	t.Parallel()

	src := behindSource()
	lister := &fakeAutoUpdateBranchLister{overrides: map[string]bool{"github/alrayyes/a#1": true}}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch(lister)

	runIdle(t, agg, act, clock, timer)

	timer.tick(t)
	require.Equal(t, 2, src.callCount(), "the repo is off but this pull request is on, so the idle tick still runs")
}

// A pull request switched off by its own choice is left alone however its
// repo is set, so it is no reason to refresh.
func TestAggregator_Run_WhileIdle_RestsForAPullRequestSwitchedOffByItsOwnChoice(t *testing.T) {
	t.Parallel()

	src := behindSource()
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"github/alrayyes/a": {}},
		overrides: map[string]bool{"github/alrayyes/a#1": false},
	}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option(), dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch(lister)

	runIdle(t, agg, act, clock, timer)
	timer.tick(t)
	timer.tick(t)

	assert.Equal(t, 1, src.callCount(), "the repo is on but this pull request is off, so the idle tick rests")
}
