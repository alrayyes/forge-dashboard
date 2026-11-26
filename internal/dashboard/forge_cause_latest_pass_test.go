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

// answerableSource is a hangingSource that can be told to answer with the
// forge's own 5xx instead.
type answerableSource struct {
	*hangingSource
	bad atomic.Bool
}

func (s *answerableSource) Fetch(ctx context.Context) dashboard.Result {
	if s.bad.Load() {
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.Forge(), ErrorKind: dashboard.ForgeErrorUpstream}}
	}

	return s.hangingSource.Fetch(ctx)
}

// "slow" is about the latest pass. A 5xx after a miss is an answer, so the
// health it holds must not keep the miss's cause.
func TestAggregator_AHeldUpstreamErrorAfterAMissDropsTheSlowCause(t *testing.T) {
	t.Parallel()

	const deadline = time.Minute

	timers := newFakeTimers()
	src := &answerableSource{hangingSource: newHangingSource(dashboard.ForgeGitHub, 1)}
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)
	agg.Refresh(t.Context())

	src.setHang(true)
	done, id := startRefresh(t, agg)
	<-src.entered
	answersDelivered(t, id)
	timers.Advance(deadline)
	<-done
	require.Equal(t, dashboard.ForgeCauseSlow, health(agg.Get(), dashboard.ForgeGitHub).Cause)

	src.bad.Store(true)
	src.unblock()
	answersDelivered(t, id) // the late fetch has ended, so the next pass asks
	agg.Refresh(t.Context())

	h := health(agg.Get(), dashboard.ForgeGitHub)
	require.True(t, h.Reachable, "the 5xx is held")
	assert.Empty(t, h.Cause)
}

// A pass that asks nothing because the budget is spent, or at its reserve, is
// not a slow one either.
func TestAggregator_APassHeldOnTheBudgetDropsTheSlowCause(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		remaining int
		// atMiss is the clock's offset while the forge is read and missed.
		atMiss time.Duration
		ctx    func(context.Context) context.Context
	}{
		// The reset is behind the clock for the miss, so the forge is asked,
		// and ahead of it for the pass under test.
		"exhausted": {remaining: 0, atMiss: 2 * time.Hour, ctx: func(ctx context.Context) context.Context { return ctx }},
		// The reserve holds the schedule only, so a person's refresh misses.
		"at its reserve": {remaining: 1, ctx: dashboard.BackgroundForTest},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			const deadline = time.Minute

			timers := newFakeTimers()
			var offset atomic.Int64
			offset.Store(int64(tc.atMiss))
			src := newHangingSource(dashboard.ForgeGitHub, 1)
			src.limit = &dashboard.RateLimit{Limit: 5000, Remaining: tc.remaining, ResetsAt: timers.Now().Add(time.Hour)}
			t.Cleanup(src.unblock)
			agg := dashboard.NewAggregator(
				[]dashboard.Source{src},
				dashboard.WithClock(func() time.Time { return timers.Now().Add(time.Duration(offset.Load())) }),
				dashboard.WithFetchDeadline(deadline, timers.After),
				dashboard.WithUserFetchDeadline(deadline),
			)
			agg.Refresh(t.Context())
			missOnce(t, agg, src, timers)
			require.Equal(t, dashboard.ForgeCauseSlow, health(agg.Get(), dashboard.ForgeGitHub).Cause)

			offset.Store(0)
			agg.Refresh(tc.ctx(t.Context()))

			h := health(agg.Get(), dashboard.ForgeGitHub)
			require.True(t, h.Reachable, "the held rows stay")
			assert.Empty(t, h.Cause)
		})
	}
}
