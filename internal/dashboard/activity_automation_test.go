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

// runIdle starts agg.Run on a short interval and returns once the entry
// refresh is done and the activity has gone idle.
func runIdle(t *testing.T, agg *dashboard.Aggregator, act *dashboard.Activity, calls func() int) {
	t.Helper()

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 20*time.Millisecond)
		close(done)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	require.Eventually(t, func() bool { return calls() >= 1 }, time.Second, 2*time.Millisecond, "the refresh on entry")
	require.Eventually(t, act.Idle, time.Second, 2*time.Millisecond)
}

// A pull request armed for merge whose mergeability flips later, with no
// webhook, is merged by the scheduled pass alone. Resting that pass while idle
// would stall "merge when green" until someone came back.
func TestAggregator_Run_WhileIdle_StillRefreshesForAnArmedPullRequest(t *testing.T) {
	t.Parallel()

	src := &flippingSource{}
	store := armedStore(armedKey)
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	agg.EnableAutoMerge([]byte("user-1"), store)

	runIdle(t, agg, act, src.callCount)
	require.Empty(t, src.mergedPullRequests(), "not mergeable yet")

	src.flip()

	require.Eventually(t, func() bool { return len(src.mergedPullRequests()) == 1 }, time.Second, 5*time.Millisecond, "the armed pull request is merged while the dashboard is idle")
}

func TestAggregator_Run_WhileIdle_RestsWhenNothingIsArmed(t *testing.T) {
	t.Parallel()

	src := &flippingSource{}
	store := armedStore()
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	agg.EnableAutoMerge([]byte("user-1"), store)

	runIdle(t, agg, act, src.callCount)
	time.Sleep(100 * time.Millisecond)

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
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	runIdle(t, agg, act, src.callCount)
	require.Empty(t, src.updatedBranches())

	lister.enable("github/alrayyes/a")

	require.Eventually(t, func() bool { return len(src.updatedBranches()) >= 1 }, time.Second, 5*time.Millisecond, "a behind pull request the hook has not yet tried is updated while idle")
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
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	agg.EnableAutoUpdateBranch([]byte("user-1"), lister)

	runIdle(t, agg, act, src.callCount)
	time.Sleep(100 * time.Millisecond)

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

func (l *switchableLister) AutoUpdateBranchRepos(context.Context, []byte) (map[string]struct{}, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.enabled, nil
}

func (l *switchableLister) RenovateRebaseLabel(context.Context, []byte) (string, error) {
	return "rebase", nil
}

func (l *switchableLister) RenovateAuthors(context.Context, []byte) ([]string, error) {
	return nil, nil
}
