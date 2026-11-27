package dashboard_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// hookedAckSource is a ctxSource whose forge can be asked whether Dependabot
// reacted, running onAck while it is being asked.
type hookedAckSource struct {
	*ctxSource

	onAck atomic.Pointer[func()]
}

func (s *hookedAckSource) DependabotAck(context.Context, string, string, int, string, time.Time) (dashboard.CommandAck, error) {
	if hook := s.onAck.Swap(nil); hook != nil {
		(*hook)()
	}

	return dashboard.CommandAck{}, nil
}

// requestRebase leaves a rebase request on #10 waiting for Dependabot to react,
// so the next rows put on the board ask the forge about it.
func requestRebase(f lateFixture) {
	f.agg.RecordBotRequest(dashboard.ForgeForgejo, "o/r", 10, dashboard.BotDependabot, dashboard.BotRebase)
}

// newAckFixture has read its forge once.
func newAckFixture(t *testing.T) (lateFixture, *hookedAckSource) {
	t.Helper()

	f := lateFixture{src: newCtxSource(), timers: newFakeTimers()}
	src := &hookedAckSource{ctxSource: f.src}
	f.agg = dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline))
	f.agg.Refresh(t.Context())

	return f, src
}

// A merge that lands while the forge is asked about Dependabot is not undone by
// rows read before it.
func TestAggregator_AMergeDuringTheAckLookupStaysOffTheBoard(t *testing.T) {
	t.Parallel()

	t.Run("a late read", func(t *testing.T) {
		t.Parallel()
		f, src := newAckFixture(t)
		f.src.slow.Store(true)
		f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
		requestRebase(f)
		merge := func() { f.agg.MarkSettled(dashboard.ForgeForgejo, "o/r", 10) }
		src.onAck.Store(&merge)

		f.src.answer <- f.src.rows(10, 11)

		f.shows(t, hasLateRow)
		assert.Equal(t, []int{11}, numbers(f.agg.Get()))
	})

	t.Run("a full refresh", func(t *testing.T) {
		t.Parallel()
		f, src := newAckFixture(t)
		requestRebase(f)
		merge := func() { f.agg.MarkSettled(dashboard.ForgeForgejo, "o/r", 10) }
		src.onAck.Store(&merge)

		f.agg.Refresh(t.Context())

		assert.Empty(t, numbers(f.agg.Get()))
	})
}

// A lookup that hangs while a late read is applied holds nobody else up.
func TestAggregator_AHangingAckLookupDoesNotHoldUpARefresh(t *testing.T) {
	t.Parallel()
	f, src := newAckFixture(t)
	f.src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	requestRebase(f)
	asked, release := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(release) })
	hang := func() {
		close(asked)
		<-release
	}
	src.onAck.Store(&hang)
	f.src.answer <- f.src.rows(11)
	select {
	case <-asked:
	case <-time.After(10 * time.Second):
		t.Fatal("the late read asked for no acknowledgement")
	}

	f.src.slow.Store(false)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.agg.Refresh(t.Context())
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the refresh waited for the hanging lookup")
	}
}
