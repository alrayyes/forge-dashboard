package dashboard_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// How a late read and a refresh running beside it keep out of each other's way.

// A late answer can reach the board while a refresh that skipped the forge is
// still on its way there. That refresh must not mark the answer as slow again.
func TestAggregator_ARefreshKeepsALateReadAppliedWhileItRan(t *testing.T) {
	t.Parallel()
	f, src := newAckFixture(t)
	f.src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	requestRebase(f)
	deliver := func() {
		f.src.answer <- f.src.rows(11)
		f.shows(t, hasLateRow)
	}
	src.onAck.Store(&deliver)

	f.agg.Refresh(t.Context()) // skips the forge, then asks about Dependabot

	assert.Empty(t, health(f.agg.Get(), dashboard.ForgeForgejo).Cause)
	assert.Equal(t, []int{11}, numbers(f.agg.Get()))
}

// assemblingSource is a second forge that can hold a refresh while the refresh
// puts its board together.
type assemblingSource struct {
	onAssemble atomic.Pointer[func()]
}

func (s *assemblingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *assemblingSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.Forge(), Reachable: true}}
}

func (s *assemblingSource) DependabotCommandsBlockedReason() string {
	if hook := s.onAssemble.Swap(nil); hook != nil {
		(*hook)()
	}

	return ""
}

// Landing in the middle of that, the late read would be overwritten by the rows
// the refresh had already picked up.
func TestAggregator_ALateReadWaitsForARefreshPuttingItsBoardTogether(t *testing.T) {
	t.Parallel()
	f := lateFixture{src: newCtxSource(), timers: newFakeTimers()}
	other := &assemblingSource{}
	f.agg = dashboard.NewAggregator([]dashboard.Source{f.src, other},
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline))
	f.agg.Refresh(t.Context())
	f.src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	assembling, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	hold := func() {
		close(assembling)
		<-release
	}
	other.onAssemble.Store(&hold)
	go func() {
		defer close(done)
		f.agg.Refresh(t.Context())
	}()
	<-assembling

	f.src.answer <- f.src.rows(11)

	assert.Never(t, func() bool { return hasLateRow(f.agg.Get()) }, 200*time.Millisecond, time.Millisecond)
	close(release)
	<-done
	f.shows(t, hasLateRow)
}
