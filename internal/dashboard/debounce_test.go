package dashboard_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeTimers is a hand-driven clock for the debouncer: After registers a
// callback, Advance moves time forward and runs whatever came due, each in
// its own goroutine as time.AfterFunc does. No test here sleeps.
type fakeTimers struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
	wg     sync.WaitGroup
}

type fakeTimer struct {
	at      time.Time
	fn      func()
	stopped bool
	fired   bool
}

func newFakeTimers() *fakeTimers {
	return &fakeTimers{now: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)}
}

func (f *fakeTimers) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.now
}

func (f *fakeTimers) After(d time.Duration, fn func()) func() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := &fakeTimer{at: f.now.Add(d), fn: fn}
	f.timers = append(f.timers, t)

	return func() bool {
		f.mu.Lock()
		defer f.mu.Unlock()
		if t.fired || t.stopped {
			return false
		}
		t.stopped = true

		return true
	}
}

// Advance moves the clock on by d, runs every timer that came due on the way
// in time order, and waits for those callbacks to return.
func (f *fakeTimers) Advance(d time.Duration) {
	f.advance(d, true)
	f.wg.Wait()
}

// AdvanceWithoutWaiting does the same but returns as soon as the due callbacks
// have started, for a test that holds one of them open on purpose. Wait joins
// them afterwards.
func (f *fakeTimers) AdvanceWithoutWaiting(d time.Duration) { f.advance(d, false) }

func (f *fakeTimers) Wait() { f.wg.Wait() }

func (f *fakeTimers) advance(d time.Duration, wait bool) {
	f.mu.Lock()
	target := f.now.Add(d)
	f.mu.Unlock()

	for {
		next := f.takeDue(target)
		if next == nil {
			return
		}
		go func() {
			defer f.wg.Done()
			next.fn()
		}()
		if wait {
			f.wg.Wait()
		}
	}
}

// takeDue marks the earliest timer due by target as fired, moves the clock to
// it and counts its callback in the wait group. With none due it moves the clock
// to target and returns nil.
func (f *fakeTimers) takeDue(target time.Time) *fakeTimer {
	f.mu.Lock()
	defer f.mu.Unlock()

	var next *fakeTimer
	for _, t := range f.timers {
		if t.stopped || t.fired || t.at.After(target) {
			continue
		}
		if next == nil || t.at.Before(next.at) {
			next = t
		}
	}
	if next == nil {
		f.now = target

		return nil
	}
	next.fired = true
	if next.at.After(f.now) {
		f.now = next.at
	}
	f.wg.Add(1)

	return next
}

// pending is how many timers are armed and have neither fired nor been stopped.
func (f *fakeTimers) pending() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, t := range f.timers {
		if !t.stopped && !t.fired {
			n++
		}
	}

	return n
}

// debounceFixture is an Aggregator over one repo-refreshing source, with the
// debouncer's timers and clock under the test's control.
type debounceFixture struct {
	clock *fakeTimers
	src   *fakeRepoRefresherSource
	agg   *dashboard.Aggregator
}

func newDebounceFixture(t *testing.T) *debounceFixture {
	t.Helper()

	clock := newFakeTimers()
	src := newFakeRepoRefresherSource()
	for _, repo := range []string{"alrayyes/a", "alrayyes/b"} {
		src.setRepo(repo, []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: repo, Number: 1, Title: repo}})
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithDebounceTimer(clock.After))

	return &debounceFixture{clock: clock, src: src, agg: agg}
}

func (f *debounceFixture) event(ctx context.Context, repo string) bool {
	return f.agg.RefreshRepoDebounced(ctx, dashboard.ForgeGitHub, "alrayyes", repo[len("alrayyes/"):], repo)
}

func TestRefreshRepoDebounced_TenEventsInTheWindowRefreshOnce(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	for range 10 {
		require.True(t, f.event(t.Context(), "alrayyes/a"))
		f.clock.Advance(100 * time.Millisecond)
	}
	assert.Zero(t, f.src.repoFetchCallCount("alrayyes/a"), "nothing runs while the burst is still inside the window")

	f.clock.Advance(2 * time.Second)

	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/a"))
}

func TestRefreshRepoDebounced_TwoReposEachRefreshOnce(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	f.event(t.Context(), "alrayyes/a")
	f.event(t.Context(), "alrayyes/b")
	f.event(t.Context(), "alrayyes/a")
	f.clock.Advance(2 * time.Second)

	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/a"))
	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/b"))
}

func TestRefreshRepoDebounced_ASteadyStreamStillRefreshesAfterFiveSeconds(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	// One event a second keeps resetting the 2 s window, so only the 5 s cap
	// can fire it.
	for range 5 {
		f.event(t.Context(), "alrayyes/a")
		f.clock.Advance(time.Second)
	}

	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/a"), "the cap fires the refresh 5 s after the first event")
}

func TestRefreshRepoDebounced_ALoneEventRefreshesAfterTwoSeconds(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	f.event(t.Context(), "alrayyes/a")
	f.clock.Advance(2*time.Second - time.Millisecond)
	assert.Zero(t, f.src.repoFetchCallCount("alrayyes/a"), "not before the window closes")

	f.clock.Advance(time.Millisecond)

	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/a"))
}

func TestRefreshRepoDebounced_AnEventInTheNextBurstStartsANewWindow(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	f.event(t.Context(), "alrayyes/a")
	f.clock.Advance(2 * time.Second)
	f.event(t.Context(), "alrayyes/a")
	f.clock.Advance(2 * time.Second)

	assert.Equal(t, 2, f.src.repoFetchCallCount("alrayyes/a"))
}

func TestRefreshRepo_ADirectCallIsNotDelayed(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	require.True(t, f.agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))

	assert.Equal(t, 1, f.src.repoFetchCallCount("alrayyes/a"), "polls and user actions refresh at once, with no clock advanced")
}

func TestRefreshRepoDebounced_ASourceThatCannotScopeAnswersFalseAtOnce(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)

	ok := f.agg.RefreshRepoDebounced(t.Context(), dashboard.ForgeForgejo, "o", "x", "o/x")

	assert.False(t, ok, "the caller falls back to a full refresh without waiting")
	assert.Zero(t, f.clock.pending(), "and nothing is armed")
}

func TestRefreshRepoDebounced_AnEventDuringARunningRefreshCausesOneFollowUp(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)
	release := make(chan struct{})
	var started atomic.Int32
	f.src.onFetchRepo = func(string) {
		started.Add(1)
		<-release
	}

	f.event(t.Context(), "alrayyes/a")
	f.clock.AdvanceWithoutWaiting(2 * time.Second)
	require.Eventually(t, func() bool { return started.Load() == 1 }, 5*time.Second, time.Millisecond)

	// Three more events arrive while the first refresh is still running, and
	// their window closes while it still is.
	for range 3 {
		f.event(t.Context(), "alrayyes/a")
	}
	f.clock.AdvanceWithoutWaiting(2 * time.Second)
	close(release)
	f.clock.Wait()

	assert.Equal(t, 2, f.src.repoFetchCallCount("alrayyes/a"), "the running refresh plus exactly one follow-up")
}

func TestRefreshRepoDebounced_ACancelledContextDropsItsPendingRefresh(t *testing.T) {
	t.Parallel()
	f := newDebounceFixture(t)
	ctx, cancel := context.WithCancel(t.Context())

	f.event(ctx, "alrayyes/a")
	require.Equal(t, 1, f.clock.pending())
	cancel()

	require.Eventually(t, func() bool { return f.clock.pending() == 0 }, 5*time.Second, time.Millisecond, "the timer is stopped, not left armed")
	f.clock.Advance(10 * time.Second)
	assert.Zero(t, f.src.repoFetchCallCount("alrayyes/a"))
}

func TestRefreshRepoDebounced_TwoAggregatorsEachRefreshTheSameRepo(t *testing.T) {
	t.Parallel()
	one := newDebounceFixture(t)
	two := newDebounceFixture(t)

	one.event(t.Context(), "alrayyes/a")
	two.event(t.Context(), "alrayyes/a")
	one.clock.Advance(2 * time.Second)
	two.clock.Advance(2 * time.Second)

	assert.Equal(t, 1, one.src.repoFetchCallCount("alrayyes/a"))
	assert.Equal(t, 1, two.src.repoFetchCallCount("alrayyes/a"), "the debouncer belongs to each Aggregator, so one user's event never drops another's")
}

func newManagedDebounce(t *testing.T) (*dashboard.Manager, *fakeTimers, *fakeRepoRefresherSource) {
	t.Helper()

	clock := newFakeTimers()
	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", nil)
	m := dashboard.NewManager(time.Hour)
	m.SetWebhookDebounceTimer(clock.After)
	t.Cleanup(m.Stop)
	m.Ensure(t.Context(), []byte("u1"), []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.fetchCallCount() >= 1 }, 5*time.Second, time.Millisecond, "the first full refresh")

	return m, clock, src
}

func TestManager_EnsureRebuildDropsAPendingDebouncedRefreshOfTheOldAggregator(t *testing.T) {
	t.Parallel()
	m, clock, src := newManagedDebounce(t)

	require.True(t, m.RefreshRepoDebounced(t.Context(), []byte("u1"), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))
	m.Ensure(t.Context(), []byte("u1"), []dashboard.Source{src})

	require.Eventually(t, func() bool { return clock.pending() == 0 }, 5*time.Second, time.Millisecond, "the replaced Aggregator's timer is stopped")
	clock.Advance(10 * time.Second)
	assert.Zero(t, src.repoFetchCallCount("alrayyes/a"), "the old Aggregator never fetches after it was replaced")
}

func TestRefreshRepoDebounced_AStoppedOwnerAcceptsNothing(t *testing.T) {
	t.Parallel()
	clock := newFakeTimers()
	src := newFakeRepoRefresherSource()
	owner, stop := context.WithCancel(t.Context())
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithDebounceTimer(clock.After), dashboard.WithDebounceOwner(owner))
	stop()

	ok := agg.RefreshRepoDebounced(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.False(t, ok)
	assert.Zero(t, clock.pending())
}

func TestRefreshRepoDebounced_ATimerThatCouldNotBeStoppedDoesNotCutTheNewerWindowShort(t *testing.T) {
	t.Parallel()

	// A real timer's callback may already be running when the next event tries
	// to stop it. Stop then returns false and both callbacks run.
	var callbacks []func()
	unstoppable := func(_ time.Duration, f func()) func() bool {
		callbacks = append(callbacks, f)

		return func() bool { return false }
	}
	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", nil)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithDebounceTimer(unstoppable))

	agg.RefreshRepoDebounced(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")
	agg.RefreshRepoDebounced(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")
	callbacks[0]()

	assert.Zero(t, src.repoFetchCallCount("alrayyes/a"), "the older event's timer must not cut the newer event's window short")
}
