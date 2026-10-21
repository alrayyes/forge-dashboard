package dashboard

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubSource answers every fetch with health, once any gate is open.
type stubSource struct {
	forge  Forge
	health ForgeHealth

	mu    sync.Mutex
	calls int
	gate  chan struct{}
	// entered is closed when a fetch first blocks on gate.
	entered chan struct{}
	once    sync.Once
}

func (s *stubSource) Forge() Forge { return s.forge }

func (s *stubSource) Fetch(context.Context) Result {
	s.mu.Lock()
	s.calls++
	gate := s.gate
	s.mu.Unlock()
	if gate != nil {
		s.once.Do(func() { close(s.entered) })
		<-gate
	}

	return Result{Health: s.health}
}

func (s *stubSource) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.calls
}

// A person's Refresh that joins a scheduled run already in flight is served by
// a rerun of that run's closure. It must still reach GitHub at the reserve.
func TestReserve_RefreshJoiningABackgroundRun_AtTheReserve_StillFetches(t *testing.T) {
	t.Parallel()

	hub := &stubSource{forge: ForgeGitHub, health: ForgeHealth{
		Forge: ForgeGitHub, Reachable: true,
		RateLimitGraphQL: &RateLimit{Limit: 5000, Remaining: 500, ResetsAt: time.Now().Add(time.Hour)},
	}}
	slow := &stubSource{
		forge: ForgeForgejo, health: ForgeHealth{Forge: ForgeForgejo, Reachable: true},
		entered: make(chan struct{}),
	}
	agg := NewAggregator([]Source{hub, slow})
	agg.Refresh(t.Context())
	require.Equal(t, 1, hub.count())

	slow.mu.Lock()
	slow.gate = make(chan struct{})
	slow.mu.Unlock()
	var wg sync.WaitGroup
	wg.Go(func() { agg.refreshBackground(t.Context()) })
	<-slow.entered
	wg.Go(func() { agg.Refresh(t.Context()) })
	require.Eventually(t, func() bool { return agg.userRefreshes.Load() == 1 }, 5*time.Second, time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	slow.mu.Lock()
	close(slow.gate)
	slow.mu.Unlock()
	wg.Wait()

	assert.Equal(t, 2, hub.count(), "the person's refresh reached GitHub, the scheduled one did not")
}
