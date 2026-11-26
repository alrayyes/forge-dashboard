package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// restartedWithAHangingForge is an aggregator holding the last run's saved
// rows, whose forge hangs on every fetch until unblocked.
func restartedWithAHangingForge(t *testing.T) (*dashboard.Aggregator, *hangingSource, *fakeTimers) {
	t.Helper()

	const deadline = time.Minute

	timers := newFakeTimers()
	src := newHangingSource(dashboard.ForgeGitHub, 1)
	src.setHang(true)
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithSnapshotCache(savedByAFirstRun(t)),
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)

	return agg, src, timers
}

func assertShownAsDown(t *testing.T, snap dashboard.Snapshot) {
	t.Helper()

	h := health(snap, dashboard.ForgeGitHub)
	assert.False(t, h.Starting)
	assert.False(t, h.Reachable)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
	assert.NotEmpty(t, h.Error)
	assert.Empty(t, h.Cause)
	assert.NotNil(t, h.StaleSince, "the saved rows still say how old they are")
	assert.ElementsMatch(t, []int{1, 2}, numbers(snap), "the saved rows stay")
}

// A first fetch that hangs for good is an outage once as many passes in a row
// have gone unanswered as hide one for a forge that was read (#5022).
func TestAggregator_AfterARestart_AFetchThatKeepsHangingIsShownAsDown(t *testing.T) {
	t.Parallel()

	agg, src, timers := restartedWithAHangingForge(t)
	missOnce(t, agg, src, timers)

	for range dashboard.ForgeFailureThreshold - 2 {
		agg.Refresh(t.Context())
		require.True(t, health(agg.Get(), dashboard.ForgeGitHub).Starting, "still short of the threshold")
	}
	agg.Refresh(t.Context())

	assertShownAsDown(t, agg.Get())

	agg.Refresh(t.Context())
	assertShownAsDown(t, agg.Get())
}

// A forge that is always slower than the deadline has each late answer
// dropped, and is an outage after the same count of passes.
func TestAggregator_AfterARestart_AForgeAlwaysSlowerThanTheDeadlineIsShownAsDown(t *testing.T) {
	t.Parallel()

	agg, src, timers := restartedWithAHangingForge(t)

	for range dashboard.ForgeFailureThreshold {
		done, id := startRefresh(t, agg)
		<-src.entered
		answersDelivered(t, id)
		timers.Advance(time.Minute)
		<-done
		src.answerOnce()
		answersDelivered(t, id) // the late fetch has ended, so the next pass asks
	}

	assertShownAsDown(t, agg.Get())
}

func TestAggregator_AfterARestart_AGoodReadAfterTheOutageClearsIt(t *testing.T) {
	t.Parallel()

	agg, src, timers := restartedWithAHangingForge(t)
	missOnce(t, agg, src, timers)
	for range dashboard.ForgeFailureThreshold - 1 {
		agg.Refresh(t.Context())
	}
	assertShownAsDown(t, agg.Get())

	src.setHang(false)
	src.unblock()
	require.Eventually(t, func() bool {
		agg.Refresh(t.Context())

		return health(agg.Get(), dashboard.ForgeGitHub).Reachable
	}, 5*time.Second, 10*time.Millisecond)

	h := health(agg.Get(), dashboard.ForgeGitHub)
	assert.False(t, h.Starting)
	assert.Empty(t, h.Cause)
	assert.Empty(t, h.Error)
	assert.Empty(t, h.ErrorKind)
	assert.Nil(t, h.StaleSince)
}
