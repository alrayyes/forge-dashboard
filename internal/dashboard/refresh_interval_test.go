package dashboard_test

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStretchedInterval(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		interval time.Duration
		want     time.Duration
	}{
		{"the default stretches to 80 minutes", 20 * time.Minute, 80 * time.Minute},
		{"four times is capped at two hours", 45 * time.Minute, 2 * time.Hour},
		{"a value already past the cap is never shortened", 3 * time.Hour, 3 * time.Hour},
		{"a value at the cap stays", 2 * time.Hour, 2 * time.Hour},
		{"a short value still stretches four times", time.Minute, 4 * time.Minute},
		{"a value too large to multiply is kept, not wrapped negative", 1000000 * time.Hour, 1000000 * time.Hour},
		{"the largest duration is kept", time.Duration(math.MaxInt64), time.Duration(math.MaxInt64)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, dashboard.StretchedInterval(tt.interval))
		})
	}
}

func refreshedWith(t *testing.T, health dashboard.ForgeHealth, repos ...dashboard.Repo) *dashboard.Aggregator {
	t.Helper()

	health.Forge = dashboard.ForgeGitHub
	health.Reachable = true
	src := &fakeSource{result: dashboard.Result{Health: health, Repos: repos}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, len(repos))

	return agg
}

func repoWithHook(name string, has bool) dashboard.Repo {
	return dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: name, HasWebhook: has}
}

// fakeRunTimer is Run's timer under a test's hand: it reports each delay Run
// arms it with and fires only when the test sends a tick.
type fakeRunTimer struct {
	ticks  chan time.Time
	delays chan time.Duration

	cancel context.CancelFunc
	done   chan struct{}
}

func newFakeRunTimer() *fakeRunTimer {
	return &fakeRunTimer{ticks: make(chan time.Time, 1), delays: make(chan time.Duration, 16)}
}

func (f *fakeRunTimer) C() <-chan time.Time { return f.ticks }

func (f *fakeRunTimer) Reset(d time.Duration) { f.delays <- d }

func (f *fakeRunTimer) Stop() bool { return true }

func (f *fakeRunTimer) option() dashboard.AggregatorOption {
	return dashboard.WithRunTimer(func(d time.Duration) dashboard.RunTimer {
		f.delays <- d

		return f
	})
}

// nextDelay is the next delay Run arms the timer with. A Run that never does
// fails the test in a second, where a bare receive would hang it.
func nextDelay(t *testing.T, timer *fakeRunTimer) time.Duration {
	t.Helper()

	select {
	case d := <-timer.delays:
		return d
	case <-time.After(time.Second):
		require.FailNow(t, "Run did not arm its timer")

		return 0
	}
}

// start runs agg.Run on this timer and returns the delay Run armed it with
// after its refresh on entry. Run stops when the test ends or at stop.
func (f *fakeRunTimer) start(t *testing.T, agg *dashboard.Aggregator, interval time.Duration) time.Duration {
	t.Helper()

	ctx, cancel := context.WithCancel(t.Context())
	f.cancel = cancel
	f.done = make(chan struct{})
	go func() {
		agg.Run(ctx, interval)
		close(f.done)
	}()
	t.Cleanup(f.stop)

	return nextDelay(t, f)
}

// tick fires the timer once and returns the delay Run arms it with next, which
// it does only after handling the tick: whatever the tick refreshed is done.
func (f *fakeRunTimer) tick(t *testing.T) time.Duration {
	t.Helper()

	f.ticks <- time.Time{}

	return nextDelay(t, f)
}

// stop ends Run and waits for it to return.
func (f *fakeRunTimer) stop() {
	f.cancel()
	<-f.done
}

// runDelays runs Run over repos and returns the delay it armed the timer with
// after its refresh on entry, then after one tick, with the refreshes made.
func runDelays(t *testing.T, repos []dashboard.Repo, interval time.Duration) (first, second time.Duration, refreshes int) {
	t.Helper()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  repos,
	}}
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option())

	first = timer.start(t, agg, interval)
	second = timer.tick(t)
	timer.stop()

	return first, second, src.callCount()
}

func TestAggregator_Run_WaitsTheStretchedDelayWhileEveryWebhookIsHealthy(t *testing.T) {
	t.Parallel()

	first, second, refreshes := runDelays(t, []dashboard.Repo{repoWithHook("alrayyes/a", true)}, 20*time.Millisecond)

	assert.Equal(t, 80*time.Millisecond, first)
	assert.Equal(t, 80*time.Millisecond, second)
	assert.Equal(t, 2, refreshes, "the entry refresh and the one the tick caused")
}

func TestAggregator_Run_KeepsTheIntervalWhenAWebhookIsMissing(t *testing.T) {
	t.Parallel()

	first, second, refreshes := runDelays(t, []dashboard.Repo{repoWithHook("alrayyes/a", false)}, 20*time.Millisecond)

	assert.Equal(t, 20*time.Millisecond, first)
	assert.Equal(t, 20*time.Millisecond, second)
	assert.Equal(t, 2, refreshes, "the entry refresh and the one the tick caused")
}

func TestAggregator_NextDelay_StretchesWhileEveryWebhookIsHealthy(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true), repoWithHook("o/b", true))

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_ReturnsToTheIntervalWhenOneWebhookIsUnhealthy(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true), repoWithHook("o/b", false))

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_NoReposIsNotCovered(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{})

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_AnExplicitLongIntervalIsTheLowerBound(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true))

	assert.Equal(t, 3*time.Hour, agg.NextDelay(3*time.Hour))
}

func TestAggregator_NextDelay_StillWaitsOutACriticalBudget(t *testing.T) {
	t.Parallel()

	health := dashboard.ForgeHealth{
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 10, ResetsAt: time.Now().Add(10 * time.Hour)},
	}
	covered := refreshedWith(t, health, repoWithHook("o/a", true))
	uncovered := refreshedWith(t, health, repoWithHook("o/a", false))

	// The budget's wait (capped at an hour) passes through unchanged: it is
	// longer than the plain interval, shorter than the stretched one.
	assert.Equal(t, time.Hour, uncovered.NextDelay(20*time.Minute))
	assert.Equal(t, 80*time.Minute, covered.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_DoesNotStretchWhileAForgeFetchFails(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))

	// The whole fetch fails: the repos are the earlier ones, which say
	// nothing about now.
	setResult(src, dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false}})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, 1)

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_DoesNotStretchWhileAnotherForgeWasNeverReachable(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_DoesNotStretchOnASnapshotRestoredAtStart(t *testing.T) {
	t.Parallel()

	cache := &memSnapshotCache{}
	src := func() dashboard.Source {
		return &fakeSource{result: dashboard.Result{
			Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
			Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
		}}
	}
	first := dashboard.NewAggregator([]dashboard.Source{src()}, dashboard.WithSnapshotCache(cache))
	first.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, first.NextDelay(20*time.Minute))

	// The saved hook state is from before the restart. Until a refresh has
	// reached the forge it says nothing about now.
	restarted := dashboard.NewAggregator([]dashboard.Source{src()}, dashboard.WithSnapshotCache(cache))
	require.Len(t, restarted.Get().Repos, 1)

	assert.Equal(t, 20*time.Minute, restarted.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_DoesNotStretchWhileARepoIsInFailedRepos(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/b", PullRequests: true}},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))

	setResult(src, dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
	})
	agg.Refresh(t.Context())

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_AFirstEverFailureIsNotYetPermanent(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/a", Issues: true}},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_OnlyTheFailedForgeBlocksCoverageAndItRecovers(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	fjRepo := dashboard.Repo{Forge: dashboard.ForgeForgejo, FullName: "o/b", HasWebhook: true}
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{fjRepo},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))

	// Forgejo's fetch fails: GitHub is fully covered, but Forgejo's repo is
	// carried over, so the short wait holds while it is down.
	down := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false}}
	setResult(fj, down)
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, 2)
	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))

	setResult(fj, dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{fjRepo},
	})
	agg.Refresh(t.Context())

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func setResult(src *fakeSource, res dashboard.Result) {
	src.mu.Lock()
	defer src.mu.Unlock()
	src.result = res
}

// staleRepoSource answers every full fetch with the same result and lets a
// scoped refresh through the embedded fake.
type staleRepoSource struct {
	*fakeRepoRefresherSource
	result dashboard.Result
}

func (s *staleRepoSource) Fetch(context.Context) dashboard.Result { return s.result }

func TestAggregator_NextDelay_StretchesAgainAfterAScopedRefreshClearsAStaleRepo(t *testing.T) {
	t.Parallel()

	result := dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/b", Issues: true}},
	}
	src := &staleRepoSource{fakeRepoRefresherSource: newFakeRepoRefresherSource(), result: result}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.NotNil(t, repoNamed(t, agg, "o/b").StaleSince)
	require.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "b", "o/b"))

	assert.Nil(t, repoNamed(t, agg, "o/b").StaleSince)
	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func repoNamed(t *testing.T, agg *dashboard.Aggregator, fullName string) dashboard.Repo {
	t.Helper()

	for _, r := range agg.Get().Repos {
		if r.FullName == fullName {
			return r
		}
	}
	require.Failf(t, "repo not in the snapshot", "%s", fullName)

	return dashboard.Repo{}
}

func TestAggregator_NextDelay_ARepoWhoseForgeHasNoHealthEntryIsNotCovered(t *testing.T) {
	t.Parallel()

	// The repo is GitHub's, but only Forgejo reported health.
	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, 1)

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_AScopedRefreshDoesNotResetHowLongAFullRefreshHasBeenFailing(t *testing.T) {
	t.Parallel()

	result := dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/b", Issues: true}},
	}
	src := &staleRepoSource{fakeRepoRefresherSource: newFakeRepoRefresherSource(), result: result}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	first := repoNamed(t, agg, "o/b").FailingSince
	require.NotNil(t, first)

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "b", "o/b"))
	require.Nil(t, repoNamed(t, agg, "o/b").StaleSince)
	agg.Refresh(t.Context())

	assert.Equal(t, first, repoNamed(t, agg, "o/b").FailingSince, "the full refresh has failed since the first time")
	assert.Nil(t, repoNamed(t, agg, "o/a").FailingSince, "and a repo that never failed has no clock")
}

// failingBranchSource answers a full fetch with a stale repo and a scoped
// refresh whose default branch read fails.
type failingBranchSource struct {
	*branchRefreshingSource
	result dashboard.Result
}

func (s *failingBranchSource) Fetch(context.Context) dashboard.Result { return s.result }

func TestAggregator_AScopedRefreshThatCannotReadTheBranchLeavesTheRepoStale(t *testing.T) {
	t.Parallel()

	result := dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/b", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/b", MainBranch: true}},
	}
	inner := newBranchRefreshingSource()
	inner.err = errors.New("branch read failed")
	agg := dashboard.NewAggregator([]dashboard.Source{&failingBranchSource{branchRefreshingSource: inner, result: result}})
	agg.Refresh(t.Context())
	require.NotNil(t, repoNamed(t, agg, "o/b").StaleSince)

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "o", "b", "o/b"))

	assert.NotNil(t, repoNamed(t, agg, "o/b").StaleSince, "the branch row is still the old one")
}
