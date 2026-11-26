package dashboard_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// When a cancellation and a tick or wake are both waiting, Go's select picks
// one at random. This many runs makes a Run that doesn't check fail every time.
const selectRaceRuns = 64

// cancellingSource cancels Run's context from inside the fetch, so whatever
// Run is waiting on next is ready at the same moment as the cancellation.
type cancellingSource struct {
	calls  atomic.Int64
	during func()
}

func (s *cancellingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *cancellingSource) Fetch(_ context.Context) dashboard.Result {
	if s.calls.Add(1) == 1 && s.during != nil {
		s.during()
	}

	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

func TestAggregator_Run_AlreadyCancelled_FetchesNothingAndFreesWaiters(t *testing.T) {
	t.Parallel()

	src := &cancellingSource{}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	agg.Run(ctx, time.Hour)

	assert.Zero(t, src.calls.Load(), "an Aggregator replaced before it started must not fetch")
	assert.True(t, agg.FirstRefreshDone(), "a request waiting on its first refresh must not wait out its limit")
}

func TestAggregator_Run_CancelledWithATickWaiting_StartsNoFetch(t *testing.T) {
	t.Parallel()

	for range selectRaceRuns {
		ctx, cancel := context.WithCancel(t.Context())
		timer := newFakeRunTimer()
		timer.ticks = make(chan time.Time, 1)
		src := &cancellingSource{during: func() {
			timer.ticks <- time.Time{}
			cancel()
		}}
		agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option())

		agg.Run(ctx, time.Hour)

		require.Equal(t, int64(1), src.calls.Load(), "only the fetch that was running when Run was cancelled")
	}
}

func TestAggregator_Run_CancelledWithAWakeWaiting_StartsNoFetch(t *testing.T) {
	t.Parallel()

	for range selectRaceRuns {
		ctx, cancel := context.WithCancel(t.Context())
		clock := newActivityClock()
		act := dashboard.NewActivity(15*time.Minute, clock.now)
		src := &cancellingSource{during: func() {
			clock.advance(time.Hour)
			act.Touch()
			cancel()
		}}
		agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

		agg.Run(ctx, time.Hour)

		require.Equal(t, int64(1), src.calls.Load(), "only the fetch that was running when Run was cancelled")
	}
}

// wakePending reports whether a wake is waiting, taking it.
func wakePending(act *dashboard.Activity) bool {
	select {
	case <-act.Woken():
		return true
	default:
		return false
	}
}

// One Activity serves every Aggregator, so a wake a replaced loop takes is one
// its successor never gets.
func TestAggregator_Run_AlreadyCancelled_LeavesAWakeForItsSuccessor(t *testing.T) {
	t.Parallel()

	clock := newActivityClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	clock.advance(time.Hour)
	act.Touch()
	agg := dashboard.NewAggregator([]dashboard.Source{&cancellingSource{}}, dashboard.WithActivity(act))
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	agg.Run(ctx, time.Hour)

	assert.True(t, wakePending(act))
}

func TestAggregator_Run_CancelledWithAWakeWaiting_LeavesItForItsSuccessor(t *testing.T) {
	t.Parallel()

	for range selectRaceRuns {
		ctx, cancel := context.WithCancel(t.Context())
		clock := newActivityClock()
		act := dashboard.NewActivity(15*time.Minute, clock.now)
		src := &cancellingSource{during: func() {
			clock.advance(time.Hour)
			act.Touch()
			cancel()
		}}
		agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))

		agg.Run(ctx, time.Hour)

		require.True(t, wakePending(act))
	}
}
