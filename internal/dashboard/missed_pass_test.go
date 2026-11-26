package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A pass that only ran out of time, or was skipped because the last fetch is
// still running, is not an outage: the forge keeps its last good rows and
// health until it has missed ForgeFailureThreshold passes in a row (#4977).
func TestAggregator_SlowPassesFlipTheForgeOnlyAfterSeveralInARow(t *testing.T) {
	t.Parallel()

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

	// The first miss is the deadline passing on a fetch that hangs.
	src.setHang(true)
	done, id := startRefresh(t, agg)
	<-src.entered
	answersDelivered(t, id)
	timers.Advance(deadline)
	<-done
	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.True(t, h.Reachable, "one deadline miss is held")
	assert.Nil(t, h.StaleSince)
	assert.Equal(t, []int{1}, numbers(agg.Get()), "the last rows stay")

	// The next ones are skipped passes, the hung fetch still running.
	agg.Refresh(t.Context())
	assert.True(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable, "two misses are still held")
	assert.Equal(t, []int{1}, numbers(agg.Get()))

	agg.Refresh(t.Context())
	h = health(agg.Get(), dashboard.ForgeGitHub)
	assert.False(t, h.Reachable, "the third miss in a row shows")
	assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
	require.NotNil(t, h.StaleSince)
	assert.Equal(t, []int{1}, numbers(agg.Get()), "the rows stay, marked stale")
}

// With no good read to hold, a missed pass shows at once, as before.
func TestAggregator_AMissedPassWithNoGoodReadShowsAtOnce(t *testing.T) {
	t.Parallel()

	const deadline = time.Minute

	timers := newFakeTimers()
	src := newHangingSource(dashboard.ForgeGitHub, 1)
	t.Cleanup(src.unblock)
	src.setHang(true)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)
	done, id := startRefresh(t, agg)
	<-src.entered
	answersDelivered(t, id)
	timers.Advance(deadline)
	<-done

	assert.False(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable)
}
