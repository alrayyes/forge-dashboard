package dashboard_test

import (
	"context"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newActivityClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)}
}

func TestActivity_IdleOnlyAfterTheIdlePeriodWithNothingAskingForTheDashboard(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	assert.False(t, act.Idle(), "a process that has only just started is not idle")

	clock.advance(14 * time.Minute)
	assert.False(t, act.Idle(), "just under the idle period")

	clock.advance(2 * time.Minute)
	assert.True(t, act.Idle(), "past the idle period with no request")
}

func TestActivity_ARequestRestartsTheIdlePeriod(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	clock.advance(20 * time.Minute)
	require.True(t, act.Idle())

	act.Touch()
	assert.False(t, act.Idle(), "a request makes it active again")

	clock.advance(14 * time.Minute)
	assert.False(t, act.Idle())
	clock.advance(2 * time.Minute)
	assert.True(t, act.Idle(), "and idle again a full idle period after the last request")
}

// An open live stream is counted as activity while it is open. The server cannot
// tell a stream in a visible tab from one on a second monitor nobody is
// looking at, and treating it as idle would leave a person who is looking at the
// board with data that stops updating until they click something. Stale data
// for someone watching costs more than the calls an open tab spends.
func TestActivity_AnOpenStreamCountsAsActivityWhileItIsOpen(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	act.StreamOpened()
	clock.advance(3 * time.Hour)
	assert.False(t, act.Idle(), "an open stream keeps the dashboard active however long it has been open")

	act.StreamClosed()
	assert.False(t, act.Idle(), "closing the stream starts the idle period from that moment")

	clock.advance(14 * time.Minute)
	assert.False(t, act.Idle())
	clock.advance(2 * time.Minute)
	assert.True(t, act.Idle())
}

func TestActivity_TwoStreamsNeedBothClosed(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	act.StreamOpened()
	act.StreamOpened()
	act.StreamClosed()
	clock.advance(time.Hour)
	assert.False(t, act.Idle(), "one stream is still open")

	act.StreamClosed()
	clock.advance(time.Hour)
	assert.True(t, act.Idle())
}

func TestActivity_ExtraCloseDoesNotGoNegative(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	act.StreamClosed()
	act.StreamOpened()
	clock.advance(time.Hour)
	assert.False(t, act.Idle(), "a stray close must not cancel the next open")
}

func TestActivity_WakesOnceWhenActivityReturnsAfterIdle(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	act.Touch()
	select {
	case <-act.Woken():
		t.Fatal("a request while already active must not wake anything")
	default:
	}

	clock.advance(time.Hour)
	require.True(t, act.Idle())

	act.Touch()
	select {
	case <-act.Woken():
	default:
		t.Fatal("the first request after idle should signal a wake")
	}

	act.Touch()
	select {
	case <-act.Woken():
		t.Fatal("the next request is not the first after idle")
	default:
	}
}

func TestActivity_AStreamOpeningAfterIdleWakes(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	clock.advance(time.Hour)
	act.StreamOpened()

	select {
	case <-act.Woken():
	default:
		t.Fatal("opening the live stream after idle should signal a wake")
	}
}

func TestActivity_ZeroIdlePeriodNeverIdles(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(0, clock.now)

	clock.advance(1000 * time.Hour)
	assert.False(t, act.Idle(), "a zero idle period turns idle mode off")
}

// TestActivity_NilIsNeverIdle is what an Aggregator built without idle mode
// (every existing caller and test) relies on.
func TestActivity_NilIsNeverIdle(t *testing.T) {
	t.Parallel()

	var act *dashboard.Activity
	assert.False(t, act.Idle())
	act.Touch()
	act.StreamOpened()
	act.StreamClosed()
}

func TestAggregator_Run_SkipsScheduledRefreshesWhileIdle(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	// Idle after 5ms with nobody asking: every scheduled tick at 20ms finds it idle.
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 20*time.Millisecond)
		close(done)
	}()

	time.Sleep(150 * time.Millisecond)
	cancel()
	<-done

	assert.Equal(t, 1, src.callCount(), "only the refresh Run does on entry; every scheduled one was skipped while idle")
}

func TestAggregator_Run_FirstRequestAfterIdleRunsOneCatchUpRefresh(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		// A long interval: nothing scheduled can explain a refresh in this test.
		agg.Run(ctx, time.Hour)
		close(done)
	}()

	require.Eventually(t, func() bool { return src.callCount() == 1 }, time.Second, 5*time.Millisecond, "the refresh on entry")
	clock.advance(time.Hour)

	act.Touch()

	require.Eventually(t, func() bool { return src.callCount() == 2 }, time.Second, 5*time.Millisecond, "the first request after idle runs one catch-up refresh")

	act.Touch()
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, 2, src.callCount(), "later requests do not each refresh")

	cancel()
	<-done
}

func TestAggregator_Run_NoCatchUpWhenNothingWasSkipped(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	act := dashboard.NewActivity(time.Hour, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, time.Hour)
		close(done)
	}()

	require.Eventually(t, func() bool { return src.callCount() == 1 }, time.Second, 5*time.Millisecond)
	act.Touch()
	act.StreamOpened()
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	assert.Equal(t, 1, src.callCount(), "activity while the data is fresh must not trigger a refresh")
}

func TestAggregator_Run_KeepsRefreshingWhileAStreamIsOpen(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	act.StreamOpened()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 10*time.Millisecond)
		close(done)
	}()

	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done

	assert.GreaterOrEqual(t, src.callCount(), 3, "an open stream counts as activity, so the schedule runs as usual")
}

func TestAggregator_ForcedRefreshAndWebhookRefreshRunWhileIdle(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", nil)
	act := dashboard.NewActivity(time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	time.Sleep(20 * time.Millisecond)
	require.True(t, act.Idle())

	agg.Refresh(t.Context())
	assert.Equal(t, 1, src.fetchCallCount(), "a refresh asked for directly runs at once, idle or not")

	agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")
	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"), "a webhook-driven refresh is the cheap path and still runs while idle")
}

func TestAggregator_Run_ReturnsPromptlyOnShutdownWhileIdle(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	act := dashboard.NewActivity(time.Millisecond, time.Now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, time.Hour)
		close(done)
	}()
	require.Eventually(t, func() bool { return src.callCount() == 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(10 * time.Millisecond)

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after cancellation while idle")
	}
}

// Signing in builds a new Aggregator, whose Run refreshes at once, and the
// request that follows touches an idle Activity. The wake that request leaves
// behind is already answered by the refresh Run has just made.
func TestAggregator_Run_AWakeLeftBeforeTheEntryRefreshIsNotAnsweredTwice(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	clock.advance(time.Hour)
	act.Touch() // idle to active: leaves a wake nobody has read
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, time.Hour)
		close(done)
	}()

	require.Eventually(t, func() bool { return src.callCount() >= 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	assert.Equal(t, 1, src.callCount(), "only the refresh on entry")
}
