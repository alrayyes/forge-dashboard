package dashboard_test

import (
	"context"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	lateUserDeadline      = time.Minute
	lateScheduledDeadline = 3 * time.Minute
)

// ctxSource is a forge with a large read: once slow, a fetch blocks until it
// is given an answer or its context is cancelled, as an HTTP call does.
type ctxSource struct {
	slow      atomic.Bool
	calls     atomic.Int32
	entered   chan struct{}
	answer    chan dashboard.Result
	cancelled chan struct{}
}

func newCtxSource() *ctxSource {
	return &ctxSource{
		entered:   make(chan struct{}, 8),
		answer:    make(chan dashboard.Result),
		cancelled: make(chan struct{}, 8),
	}
}

func (s *ctxSource) Forge() dashboard.Forge { return dashboard.ForgeForgejo }

func (s *ctxSource) rows(prs ...int) dashboard.Result {
	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.Forge(), Reachable: true}}
	for _, n := range prs {
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: s.Forge(), Repo: "o/r", Number: n})
	}
	res.Repos = []dashboard.Repo{{Forge: s.Forge(), FullName: "o/r"}}

	return res
}

func (s *ctxSource) Fetch(ctx context.Context) dashboard.Result {
	s.calls.Add(1)
	if !s.slow.Load() {
		return s.rows(10)
	}
	s.entered <- struct{}{}
	select {
	case res := <-s.answer:
		return res
	case <-ctx.Done():
		s.cancelled <- struct{}{}

		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.Forge(), ErrorKind: dashboard.ForgeErrorUnreachable}}
	}
}

type lateFixture struct {
	agg    *dashboard.Aggregator
	src    *ctxSource
	timers *fakeTimers
}

func unreadLateFixture(opts ...dashboard.AggregatorOption) lateFixture {
	f := lateFixture{src: newCtxSource(), timers: newFakeTimers()}
	f.agg = dashboard.NewAggregator([]dashboard.Source{f.src}, append([]dashboard.AggregatorOption{
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline),
	}, opts...)...)

	return f
}

// newLateFixture has read its forge once and made it slow.
func newLateFixture(t *testing.T, opts ...dashboard.AggregatorOption) lateFixture {
	t.Helper()

	f := unreadLateFixture(opts...)
	f.agg.Refresh(t.Context())
	f.src.slow.Store(true)

	return f
}

// start runs refresh and waits for it to be stuck in the slow fetch.
func (f lateFixture) start(t *testing.T, refresh func()) <-chan struct{} {
	t.Helper()

	done := make(chan struct{})
	go func() {
		defer close(done)
		refresh()
	}()
	<-f.src.entered

	return done
}

// giveUp runs refresh against the slow forge up to the user deadline.
func (f lateFixture) giveUp(t *testing.T, refresh func()) {
	t.Helper()

	done := f.start(t, refresh)
	f.timers.Advance(lateUserDeadline)
	<-done
}

// shows waits for the board to satisfy cond without asking for a refresh.
func (f lateFixture) shows(t *testing.T, cond func(dashboard.Snapshot) bool) {
	t.Helper()

	require.Eventually(t, func() bool { return cond(f.agg.Get()) }, 10*time.Second, time.Millisecond)
}

// hasLateRow reports whether snap holds the pull request only the late read has.
func hasLateRow(snap dashboard.Snapshot) bool {
	return slices.ContainsFunc(snap.PullRequests, func(pr dashboard.PullRequest) bool { return pr.Number == 11 })
}

func assertSlow(t *testing.T, snap dashboard.Snapshot) {
	t.Helper()

	h := health(snap, dashboard.ForgeForgejo)
	assert.True(t, h.Reachable, "slow is not unreachable")
	assert.Equal(t, dashboard.ForgeCauseSlow, h.Cause)
	assert.Empty(t, h.ErrorKind)
	assert.Nil(t, h.StaleSince)
	assert.NotNil(t, h.RowsReadAt)
}

// Opening the board after an idle spell, or pressing Refresh, stops waiting at
// the user deadline. The read itself goes on and is applied when it answers
// (#5059).
func TestAggregator_AReadSlowerThanTheUserDeadlineIsAppliedWhenItAnswers(t *testing.T) {
	t.Parallel()

	for name, refresh := range map[string]func(context.Context, *dashboard.Aggregator){
		"catch-up after an idle spell": func(ctx context.Context, a *dashboard.Aggregator) { a.CatchUpForTest(ctx) },
		"a person presses Refresh":     func(ctx context.Context, a *dashboard.Aggregator) { a.Refresh(ctx) },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			f := newLateFixture(t)

			f.giveUp(t, func() { refresh(t.Context(), f.agg) })

			require.Empty(t, f.src.cancelled, "the read was cancelled at the user deadline")
			assertSlow(t, f.agg.Get())
			assert.Equal(t, []int{10}, numbers(f.agg.Get()), "the last rows are held")

			f.src.answer <- f.src.rows(11)

			f.shows(t, hasLateRow)
			h := health(f.agg.Get(), dashboard.ForgeForgejo)
			assert.True(t, h.Reachable)
			assert.Empty(t, h.Cause)
			assert.Nil(t, h.RowsReadAt)
			assert.EqualValues(t, 2, f.src.calls.Load(), "no other refresh was needed")
		})
	}
}

func TestAggregator_SubscribersAreToldOfALateRead(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	updates, unsubscribe := f.agg.Subscribe()
	t.Cleanup(unsubscribe)

	f.src.answer <- f.src.rows(11)

	require.Eventually(t, func() bool {
		select {
		case snap := <-updates:
			return hasLateRow(snap)
		default:
			return false
		}
	}, 10*time.Second, time.Millisecond)
}

// A click that joins a scheduled pass stops waiting at the user deadline too,
// and leaves that pass's read running.
func TestAggregator_AClickJoiningAScheduledPassLeavesItsReadRunning(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	scheduled := f.start(t, func() { f.agg.Refresh(dashboard.BackgroundForTest(t.Context())) })
	armed := f.timers.Pending()
	go f.agg.Refresh(t.Context())
	require.Eventually(t, func() bool { return f.timers.Pending() > armed }, 10*time.Second, time.Millisecond)

	f.timers.Advance(lateUserDeadline)
	<-scheduled

	require.Empty(t, f.src.cancelled)
	assertSlow(t, f.agg.Get())
	f.src.answer <- f.src.rows(11)
	f.shows(t, hasLateRow)
}

// A forge still being read within the scheduled deadline has not been silent,
// however often a person asks again.
func TestAggregator_AskingAgainWhileALateReadRunsDoesNotMakeTheForgeUnreachable(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	for range dashboard.ForgeFailureThreshold + 1 {
		f.agg.Refresh(t.Context())
		assertSlow(t, f.agg.Get())
	}
	f.agg.Refresh(dashboard.BackgroundForTest(t.Context()))

	assertSlow(t, f.agg.Get())
	assert.EqualValues(t, 2, f.src.calls.Load(), "the running read is not doubled")
}

// Silence past the scheduled deadline is a missed pass like any other: the read
// is cancelled, and ForgeFailureThreshold of them show the forge unreachable.
func TestAggregator_ALateReadSilentPastTheScheduledDeadlineIsAMiss(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)

	for i := range dashboard.ForgeFailureThreshold {
		f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
		f.timers.Advance(lateScheduledDeadline - lateUserDeadline - time.Second)
		require.Empty(t, f.src.cancelled, "cancelled before the scheduled deadline")
		f.timers.Advance(time.Second)
		<-f.src.cancelled

		h := health(f.agg.Get(), dashboard.ForgeForgejo)
		require.Equal(t, i < dashboard.ForgeFailureThreshold-1, h.Reachable, "miss %d", i+1)
		// The cancelled fetch has to end before the forge is asked again.
		f.agg.WaitSourcesIdleForTest()
	}

	h := health(f.agg.Get(), dashboard.ForgeForgejo)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
	assert.Empty(t, h.Cause)
	assert.NotNil(t, h.StaleSince)
	assert.Equal(t, []int{10}, numbers(f.agg.Get()))
}

// A forge never read has no rows to hold: slow while it is being read, and
// unreachable once silent past the scheduled deadline.
func TestAggregator_AFirstReadSilentPastTheScheduledDeadlineIsUnreachable(t *testing.T) {
	t.Parallel()
	f := unreadLateFixture()
	f.src.slow.Store(true)

	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	h := health(f.agg.Get(), dashboard.ForgeForgejo)
	assert.True(t, h.Reachable)
	assert.Equal(t, dashboard.ForgeCauseSlow, h.Cause)
	assert.Nil(t, h.RowsReadAt)

	f.timers.Advance(lateScheduledDeadline - lateUserDeadline)
	<-f.src.cancelled

	h = health(f.agg.Get(), dashboard.ForgeForgejo)
	assert.False(t, h.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
}

func TestAggregator_ALateFailureIsShown(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	f.src.answer <- dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, ErrorKind: dashboard.ForgeErrorUnauthorized}}

	f.shows(t, func(s dashboard.Snapshot) bool { return !health(s, dashboard.ForgeForgejo).Reachable })
	assert.Equal(t, dashboard.ForgeErrorUnauthorized, health(f.agg.Get(), dashboard.ForgeForgejo).ErrorKind)
	assert.Equal(t, []int{10}, numbers(f.agg.Get()))
}

// The late read was taken before the merge, so it still lists the pull request.
func TestAggregator_ALateReadDoesNotBringBackAMergedPullRequest(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	f.agg.MarkSettled(dashboard.ForgeForgejo, "o/r", 10)
	f.agg.Refresh(t.Context()) // a pass behind the running read holds the rows

	f.src.answer <- f.src.rows(10, 11)

	f.shows(t, hasLateRow)
	assert.Equal(t, []int{11}, numbers(f.agg.Get()))
}

// Shutting down, or replacing the Aggregator, ends a late read and applies
// nothing from it.
func TestAggregator_ALateReadEndsWithItsOwner(t *testing.T) {
	t.Parallel()
	owner, stop := context.WithCancel(t.Context())
	f := newLateFixture(t, dashboard.WithDebounceOwner(owner))
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	stop()
	<-f.src.cancelled
	f.agg.WaitSourcesIdleForTest()
	f.timers.Advance(lateScheduledDeadline)

	assertSlow(t, f.agg.Get())
}

func TestAggregator_ALateReadEndsWithTheContextThatAskedForIt(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(t.Context())
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(ctx) })
	require.Empty(t, f.src.cancelled)

	cancel()

	<-f.src.cancelled
}
