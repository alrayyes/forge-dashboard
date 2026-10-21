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
	// budget, when set, is reported on every fetch and falls by step after it.
	budget *RateLimit
	step   int

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
	health := s.health
	if s.budget != nil {
		rl := *s.budget
		health.RateLimitGraphQL = &rl
		s.budget.Remaining -= s.step
	}
	s.mu.Unlock()
	if gate != nil {
		s.once.Do(func() { close(s.entered) })
		<-gate
	}

	return Result{Health: health}
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

func budgetStub(forge Forge, limit, remaining, step int, resets time.Time) *stubSource {
	return &stubSource{
		forge:  forge,
		health: ForgeHealth{Forge: forge, Reachable: true},
		budget: &RateLimit{Limit: limit, Remaining: remaining, ResetsAt: resets},
		step:   step,
	}
}

// scheduledRefreshes runs two refreshes a person asked for, which teach the
// aggregator what one costs, and then n scheduled ones, as Run would.
func scheduledRefreshes(t *testing.T, src *stubSource, n int) {
	t.Helper()

	agg := NewAggregator([]Source{src})
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())
	for range n {
		agg.refreshBackground(t.Context())
	}
}

func TestReserve_ScheduledRefresh(t *testing.T) {
	t.Parallel()

	later := time.Now().Add(time.Hour)
	tests := []struct {
		name  string
		src   *stubSource
		calls int
	}{
		{"at the reserve waits", budgetStub(ForgeGitHub, 5000, 500, 0, later), 2},
		{"above the reserve runs", budgetStub(ForgeGitHub, 5000, 501, 0, later), 5},
		// 1000, then 600 after a refresh that cost 400: over the reserve, but
		// another 400 would leave 200.
		{"waits when its last cost would cross the reserve", budgetStub(ForgeGitHub, 5000, 1000, 400, later), 2},
		{"runs once the reset has passed", budgetStub(ForgeGitHub, 5000, 500, 0, time.Now().Add(-time.Minute)), 5},
		// 10% of 100 is 10, so the floor of 50 holds it back at 50.
		{"a small budget keeps a floor", budgetStub(ForgeGitHub, 100, 50, 0, later), 2},
		{"forgejo reports no budget and is never held", noBudget(budgetStub(ForgeForgejo, 5000, 0, 0, later)), 5},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			scheduledRefreshes(t, tt.src, 3)

			assert.Equal(t, tt.calls, tt.src.count())
		})
	}
}

func noBudget(s *stubSource) *stubSource {
	s.budget = nil

	return s
}
