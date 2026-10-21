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

// Merge, Update branch, rebases, Close, Enable auto-merge and queued actions
// never ask the reserve: only a budget with nothing left holds a queued action.
// This runs one through the real runner with REST at the reserve.
func TestReserve_QueuedAction_AtTheReserve_StillRuns(t *testing.T) {
	t.Parallel()

	rig := newQueueRig(t, behindPR(5, "alice"))
	rig.enqueue(t, dashboard.ActionUpdateBranch, 5)
	rig.clock.advance(33 * time.Minute)
	rig.src.setHealth(dashboard.ForgeHealth{
		Forge: dashboard.ForgeGitHub, Reachable: true,
		RateLimitREST:    &dashboard.RateLimit{Limit: 5000, Remaining: reserved, ResetsAt: queueReset.Add(time.Hour)},
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: reserved, ResetsAt: queueReset.Add(time.Hour)},
	})

	rig.agg.ProcessQueuedActions(t.Context())

	assert.Equal(t, []string{"update o/r#5"}, rig.src.writes())
	assert.Equal(t, dashboard.QueuedDone, rig.only(t).Status)
}

// Someone opening the board after an idle spell wakes the schedule. That is a
// person, so the reserve is theirs to use.
func TestReserve_ActivityWake_AtTheReserve_Refreshes(t *testing.T) {
	t.Parallel()

	src := newBudgetSource(graphQL, reserved, 0)
	clock := &fakeClock{t: queueT0}
	act := dashboard.NewActivity(time.Minute, clock.now)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithActivity(act))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, time.Hour)
		close(done)
	}()
	defer func() {
		cancel()
		<-done
	}()
	require.Eventually(t, func() bool { return src.fetchCallCount() == 1 }, 5*time.Second, time.Millisecond)

	clock.advance(2 * time.Minute)
	act.Touch()

	require.Eventually(t, func() bool { return src.fetchCallCount() == 2 }, 5*time.Second, time.Millisecond)
}
