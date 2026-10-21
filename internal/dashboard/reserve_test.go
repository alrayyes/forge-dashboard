package dashboard_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// budget is which of GitHub's two independent budgets a test spends.
type budget string

const (
	graphQL budget = "graphql"
	rest    budget = "rest"
)

// budgetSource is a GitHub source whose budget falls by step on every full
// fetch, from remaining, and which holds one pull request with pending checks
// so the CI poll has something to ask about.
type budgetSource struct {
	*batchSource

	which  budget
	limit  int
	step   int
	resets time.Time

	bmu       sync.Mutex
	remaining int
}

func newBudgetSource(which budget, remaining, step int) *budgetSource {
	src := &budgetSource{
		batchSource: newBatchSource(),
		which:       which,
		limit:       5000,
		step:        step,
		remaining:   remaining,
		resets:      time.Now().Add(time.Hour).UTC(),
	}
	src.setRepo("me/a", []dashboard.PullRequest{pendingPR("me/a", 1)})

	return src
}

func (s *budgetSource) Fetch(ctx context.Context) dashboard.Result {
	res := s.batchSource.Fetch(ctx)
	s.bmu.Lock()
	defer s.bmu.Unlock()
	rl := &dashboard.RateLimit{Limit: s.limit, Remaining: s.remaining, ResetsAt: s.resets}
	switch s.which {
	case graphQL:
		res.Health.RateLimitGraphQL = rl
	case rest:
		res.Health.RateLimitREST = rl
	}
	s.remaining -= s.step

	return res
}

// reserved is the reserve of a 5000-point budget.
const reserved = 500

func runFor(t *testing.T, agg *dashboard.Aggregator) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 10*time.Millisecond)
		close(done)
	}()
	time.Sleep(150 * time.Millisecond)
	cancel()
	<-done
}

func TestReserve_ScheduledFullRefresh_AtTheReserve_WaitsForTheReset(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			// The entry refresh sees an empty snapshot and runs; it leaves the
			// budget at the reserve, so every scheduled one after it waits.
			src := newBudgetSource(which, reserved, 0)
			agg := dashboard.NewAggregator([]dashboard.Source{src})

			runFor(t, agg)

			assert.Equal(t, 1, src.fetchCallCount())
		})
	}
}

func TestReserve_ScheduledFullRefresh_AboveTheReserve_Runs(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			src := newBudgetSource(which, reserved+1, 0)
			agg := dashboard.NewAggregator([]dashboard.Source{src})

			runFor(t, agg)

			assert.Greater(t, src.fetchCallCount(), 2)
		})
	}
}

func TestReserve_ScheduledFullRefresh_WaitsWhenItsLastCostWouldCrossTheReserve(t *testing.T) {
	t.Parallel()

	// 1000, then 600 after one refresh that cost 400: 600 is over the reserve,
	// but another 400 would take it to 200, under.
	src := newBudgetSource(graphQL, 1000, 400)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 10*time.Millisecond)
		close(done)
	}()
	require.Eventually(t, func() bool { return src.fetchCallCount() >= 2 }, 5*time.Second, 5*time.Millisecond)
	time.Sleep(150 * time.Millisecond)
	cancel()
	<-done

	assert.Equal(t, 2, src.fetchCallCount(), "the entry refresh and one more, then it waits")
}

func TestReserve_ScheduledFullRefresh_ResetPassed_Runs(t *testing.T) {
	t.Parallel()

	src := newBudgetSource(graphQL, reserved, 0)
	src.resets = time.Now().Add(-time.Minute)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	runFor(t, agg)

	assert.Greater(t, src.fetchCallCount(), 2, "the budget has come back")
}

func TestReserve_SmallBudget_KeepsAFloor(t *testing.T) {
	t.Parallel()

	// 10% of 100 is 10; the floor of 50 holds it back at 50.
	src := newBudgetSource(graphQL, 50, 0)
	src.limit = 100
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	runFor(t, agg)

	assert.Equal(t, 1, src.fetchCallCount())
}

func TestReserve_ForceRefresh_AtTheReserve_Runs(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			src := newBudgetSource(which, reserved, 0)
			agg := dashboard.NewAggregator([]dashboard.Source{src})
			agg.Refresh(t.Context())

			agg.Refresh(t.Context())

			assert.Equal(t, 2, src.fetchCallCount(), "a refresh the user asked for ignores the reserve")
		})
	}
}

func TestReserve_ForceRefresh_SpentBudget_DoesNotRun(t *testing.T) {
	t.Parallel()

	src := newBudgetSource(graphQL, 0, 0)
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	agg.Refresh(t.Context())

	assert.Equal(t, 1, src.fetchCallCount())
}

func TestReserve_CIPoll_AtTheReserve_WaitsAndAboveRuns(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			low := newBudgetSource(which, reserved, 0)
			lowAgg := dashboard.NewAggregator([]dashboard.Source{low})
			lowAgg.Refresh(t.Context())
			lowAgg.PollCI(t.Context())
			assert.Equal(t, 0, low.batchCount(), "at the reserve the poll waits")

			ok := newBudgetSource(which, reserved+1, 0)
			okAgg := dashboard.NewAggregator([]dashboard.Source{ok})
			okAgg.Refresh(t.Context())
			okAgg.PollCI(t.Context())
			assert.Equal(t, 1, ok.batchCount(), "above it the poll runs")
		})
	}
}

func TestReserve_ScopedWebhookRefresh_RunsAtTheReserveButNotWhenSpent(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			low := newBudgetSource(which, reserved, 0)
			lowAgg := dashboard.NewAggregator([]dashboard.Source{low})
			lowAgg.Refresh(t.Context())
			require.True(t, lowAgg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "me", "a", "me/a"))
			assert.Equal(t, 1, low.repoFetchCallCount("me/a"), "the cheap path runs at the reserve")

			spent := newBudgetSource(which, 0, 0)
			spentAgg := dashboard.NewAggregator([]dashboard.Source{spent})
			spentAgg.Refresh(t.Context())
			require.True(t, spentAgg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "me", "a", "me/a"), "the caller must not fall back to a full refresh")
			assert.Equal(t, 0, spent.repoFetchCallCount("me/a"), "a spent budget holds it")
		})
	}
}

func TestReserve_HookMaintenance_AtTheReserve_Waits(t *testing.T) {
	t.Parallel()

	health := dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: reserved, ResetsAt: time.Now().Add(time.Hour)},
	}
	src := upgradeSource(health, covered(dashboard.ForgeGitHub, "me/a")...)
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)

	assert.Empty(t, src.called())
}

func TestReserve_Forgejo_IsNeverHeld(t *testing.T) {
	t.Parallel()

	src := newBudgetSource(graphQL, 0, 0)
	src.forge = dashboard.ForgeForgejo
	src.which = "none"
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	runFor(t, agg)

	assert.Greater(t, src.fetchCallCount(), 2, "no reported budget, no reserve")
}

// Merge, Update branch, rebases, Close, Enable auto-merge and queued actions
// never ask the reserve: the only thing that holds a queued action is a budget
// with nothing left.
func TestReserve_QueuedAction_AtTheReserve_IsNotHeld(t *testing.T) {
	t.Parallel()

	resets := time.Now().Add(time.Hour)
	for _, which := range []budget{graphQL, rest} {
		h := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub}
		rl := &dashboard.RateLimit{Limit: 5000, Remaining: reserved, ResetsAt: resets}
		if which == graphQL {
			h.RateLimitGraphQL = rl
		} else {
			h.RateLimitREST = rl
		}
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{h}}

		_, limited := dashboard.RateLimitedUntil(snap, dashboard.ForgeGitHub, time.Now())

		assert.False(t, limited, which)
	}
}
