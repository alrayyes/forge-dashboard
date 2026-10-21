package dashboard_test

import (
	"context"
	"fmt"
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

// A tab someone is looking at holds the dashboard active for as long as it
// keeps saying so. An open live stream alone is not use: the server cannot
// tell a stream in a tab someone is looking at from one in a tab nobody is.
func TestActivity_AVisibleViewerHoldsTheDashboardActiveWhileItKeepsBeating(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	for range 10 {
		act.Present("tab-a", true)
		clock.advance(dashboard.PresenceTTL / 2)
		assert.False(t, act.Idle(), "a tab that keeps sending heartbeats is use however long it goes on")
	}
}

func TestActivity_AViewerThatGoesHiddenLetsGoAndTheIdlePeriodStartsThen(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	act.Present("tab-a", true)
	clock.advance(3 * time.Hour)
	act.Present("tab-a", true)
	act.Present("tab-a", false)
	assert.False(t, act.Idle(), "hiding the tab starts the idle period from that moment")

	clock.advance(14 * time.Minute)
	assert.False(t, act.Idle())
	clock.advance(2 * time.Minute)
	assert.True(t, act.Idle(), "a hidden tab does not hold the refresh active")
}

func TestActivity_ADeadViewerStopsCountingAfterTheTTLWithoutAHiddenMessage(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	act.Present("tab-a", true)
	clock.advance(dashboard.PresenceTTL - time.Second)
	assert.False(t, act.Idle(), "still inside the TTL")

	clock.advance(2*time.Second + time.Minute)
	assert.True(t, act.Idle(), "a closed laptop or crashed browser stops counting after a bounded time")
}

func TestActivity_OneHiddenTabDoesNotReleaseAnotherVisibleOne(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	act.Present("tab-a", true)
	act.Present("tab-b", true)
	act.Present("tab-a", false)
	clock.advance(30 * time.Second)
	act.Present("tab-b", true)
	clock.advance(time.Hour - 30*time.Second)
	act.Present("tab-b", true)
	assert.False(t, act.Idle(), "tab b is still visible")

	act.Present("tab-b", false)
	clock.advance(2 * time.Minute)
	assert.True(t, act.Idle(), "every tab hidden")
}

func TestActivity_AViewerBecomingVisibleAfterIdleWakesOnce(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)

	clock.advance(time.Hour)
	require.True(t, act.Idle())

	act.Present("tab-a", false)
	select {
	case <-act.Woken():
		t.Fatal("a hidden report is not use and must not wake")
	default:
	}

	act.Present("tab-a", true)
	select {
	case <-act.Woken():
	default:
		t.Fatal("a tab becoming visible after idle should signal a wake")
	}

	act.Present("tab-a", true)
	select {
	case <-act.Woken():
		t.Fatal("the next heartbeat is not the first after idle")
	default:
	}
}

func TestActivity_AHiddenReportFromAnUnknownViewerChangesNothing(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	clock.advance(time.Hour)
	act.Present("never-seen", false)
	assert.True(t, act.Idle(), "a hidden report is not use")
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
	act.Present("x", true)
	act.Present("x", false)
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
	act.Present("tab-a", true)
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	assert.Equal(t, 1, src.callCount(), "activity while the data is fresh must not trigger a refresh")
}

func TestAggregator_Run_KeepsRefreshingWhileAViewerIsVisible(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	act := dashboard.NewActivity(5*time.Millisecond, time.Now)
	act.Present("tab-a", true)
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

	assert.GreaterOrEqual(t, src.callCount(), 3, "a visible tab counts as activity, so the schedule runs as usual")
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

func TestActivity_TheNumberOfViewersIsCappedAndTheOldestGoesFirst(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	act.Present("first-tab", true)
	for i := range dashboard.MaxViewers {
		clock.advance(time.Second)
		act.Present(fmt.Sprintf("tab-%d", i), true)
	}
	assert.Equal(t, dashboard.MaxViewers, act.ViewerCount(), "a client making up ids cannot grow the map")

	act.Present("first-tab", false)
	assert.Equal(t, dashboard.MaxViewers, act.ViewerCount(), "the oldest id was dropped to make room, so letting it go changes nothing")
}

func TestActivity_ExpiredViewersAreDroppedWhateverOtherTabsAreBeating(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(time.Minute, clock.now)

	for i := range 5 {
		act.Present(fmt.Sprintf("gone-%d", i), true)
	}
	clock.advance(dashboard.PresenceTTL + time.Second)
	act.Present("live-tab", true)

	assert.Equal(t, 1, act.ViewerCount())
}

func TestActivity_ResetForgetsEveryTab(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	act.Present("tab-one-aaaa", true)
	act.Present("tab-two-bbbb", true)
	require.Equal(t, 2, act.ViewerCount())

	act.Reset()

	assert.Zero(t, act.ViewerCount())
}

func TestActivity_ResetRestartsTheIdlePeriodLikeAFreshProcess(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	clock.advance(20 * time.Minute)
	require.True(t, act.Idle())

	act.Reset()

	assert.False(t, act.Idle())
}

func TestActivity_ResetOnNilIsSafe(t *testing.T) {
	t.Parallel()

	var act *dashboard.Activity

	assert.NotPanics(t, act.Reset)
}
