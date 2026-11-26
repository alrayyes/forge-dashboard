package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// slowForge is an aggregator whose forge read well once and then hangs.
func slowForge(t *testing.T) (*dashboard.Aggregator, *hangingSource, *fakeTimers) {
	t.Helper()

	const deadline = time.Minute

	timers := newFakeTimers()
	src := newHangingSource(dashboard.ForgeGitHub, 1)
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)
	agg.Refresh(t.Context())
	<-src.served

	return agg, src, timers
}

// missOnce makes one pass hit its deadline.
func missOnce(t *testing.T, agg *dashboard.Aggregator, src *hangingSource, timers *fakeTimers) {
	t.Helper()

	src.setHang(true)
	done, id := startRefresh(t, agg)
	<-src.entered
	answersDelivered(t, id)
	timers.Advance(time.Minute)
	<-done
}

// A held read is not a fresh one: the forge reads as reachable with the old
// rows, and says why they are old, so the page need not say "Live" (#4998).
func TestAggregator_AHeldMissedPassSaysTheForgeIsSlow(t *testing.T) {
	t.Parallel()

	agg, src, timers := slowForge(t)
	assert.Empty(t, health(agg.Get(), dashboard.ForgeGitHub).Cause, "a fresh read has no cause")

	missOnce(t, agg, src, timers)
	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.True(t, h.Reachable)
	assert.Equal(t, dashboard.ForgeCauseSlow, h.Cause)
}

func TestAggregator_AHeldSkippedPassSaysTheForgeIsSlow(t *testing.T) {
	t.Parallel()

	agg, src, timers := slowForge(t)
	missOnce(t, agg, src, timers)

	agg.Refresh(t.Context())
	assert.Equal(t, dashboard.ForgeCauseSlow, health(agg.Get(), dashboard.ForgeGitHub).Cause)
}

func TestAggregator_TheNextGoodReadClearsTheSlowCause(t *testing.T) {
	t.Parallel()

	agg, src, timers := slowForge(t)
	missOnce(t, agg, src, timers)

	src.setHang(false)
	src.unblock()
	require.Eventually(t, func() bool {
		agg.Refresh(t.Context())

		return health(agg.Get(), dashboard.ForgeGitHub).Cause == ""
	}, 5*time.Second, 10*time.Millisecond)
}

// Three misses in a row show the outage, and an outage is not "slow".
func TestAggregator_TheMissThatShowsTheOutageHasNoCause(t *testing.T) {
	t.Parallel()

	agg, src, timers := slowForge(t)
	missOnce(t, agg, src, timers)
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	h := health(agg.Get(), dashboard.ForgeGitHub)
	require.False(t, h.Reachable)
	assert.Empty(t, h.Cause)
}

// A restored forge whose first fetch hangs has had no answer yet: it is still
// starting, and says so, through a missed pass and a skipped one.
func TestAggregator_AfterARestart_AHungFirstFetchKeepsTheStartingCause(t *testing.T) {
	t.Parallel()

	const deadline = time.Minute

	timers := newFakeTimers()
	src := newHangingSource(dashboard.ForgeGitHub, 1)
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithSnapshotCache(savedByAFirstRun(t)),
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)

	missOnce(t, agg, src, timers)
	missed := health(agg.Get(), dashboard.ForgeGitHub)
	require.True(t, missed.Starting)
	assert.Equal(t, dashboard.ForgeCauseStarting, missed.Cause, "after the missed pass")
	assert.Empty(t, missed.ErrorKind, "a start-up gap is not an outage")
	assert.Empty(t, missed.Error)

	agg.Refresh(t.Context())
	skipped := health(agg.Get(), dashboard.ForgeGitHub)
	require.True(t, skipped.Starting)
	assert.Equal(t, dashboard.ForgeCauseStarting, skipped.Cause, "after the skipped pass")
	assert.Empty(t, skipped.ErrorKind)
}

// A held 5xx is a real answer from the forge, not a slow one: it carries no cause.
func TestAggregator_AHeldUpstreamErrorHasNoCause(t *testing.T) {
	t.Parallel()

	src := &answeringBadly{}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.set(dashboard.ForgeErrorUpstream)
	agg.Refresh(t.Context())

	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.True(t, h.Reachable, "the one 5xx is held")
	assert.Empty(t, h.Cause)
}
