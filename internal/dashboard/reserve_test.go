package dashboard_test

import (
	"context"
	"sync"
	"sync/atomic"
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

// budgetSource is a GitHub source that reports a fixed budget, and which holds
// one pull request with pending checks so the CI poll has something to ask about.
type budgetSource struct {
	*batchSource

	which  budget
	limit  int
	resets time.Time

	bmu       sync.Mutex
	remaining int
}

func newBudgetSource(which budget, remaining int) *budgetSource {
	src := &budgetSource{
		batchSource: newBatchSource(),
		which:       which,
		limit:       5000,
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

	return res
}

// reserved is the reserve of a 5000-point budget.
const reserved = 500

func TestReserve_ForceRefresh_AtTheReserve_Runs(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			src := newBudgetSource(which, reserved)
			agg := dashboard.NewAggregator([]dashboard.Source{src})
			agg.Refresh(t.Context())

			agg.Refresh(t.Context())

			assert.Equal(t, 2, src.fetchCallCount(), "a refresh the user asked for ignores the reserve")
		})
	}
}

func TestReserve_ForceRefresh_SpentBudget_DoesNotRun(t *testing.T) {
	t.Parallel()

	src := newBudgetSource(graphQL, 0)
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

			low := newBudgetSource(which, reserved)
			lowAgg := dashboard.NewAggregator([]dashboard.Source{low})
			lowAgg.Refresh(t.Context())
			lowAgg.PollCI(t.Context())
			assert.Equal(t, 0, low.batchCount(), "at the reserve the poll waits")

			ok := newBudgetSource(which, reserved+1)
			okAgg := dashboard.NewAggregator([]dashboard.Source{ok})
			okAgg.Refresh(t.Context())
			okAgg.PollCI(t.Context())
			assert.Equal(t, 1, ok.batchCount(), "above it the poll runs")
		})
	}
}

func TestReserve_ScopedWebhookRefresh_AtTheReserve_WaitsAndAboveRuns(t *testing.T) {
	t.Parallel()

	for _, which := range []budget{graphQL, rest} {
		t.Run(string(which), func(t *testing.T) {
			t.Parallel()

			low := newBudgetSource(which, reserved)
			lowAgg := dashboard.NewAggregator([]dashboard.Source{low})
			lowAgg.Refresh(t.Context())
			require.True(t, lowAgg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "me", "a", "me/a"), "the caller must not fall back to a full refresh")
			assert.Equal(t, 0, low.repoFetchCallCount("me/a"), "at the reserve it waits")

			ok := newBudgetSource(which, reserved+1)
			okAgg := dashboard.NewAggregator([]dashboard.Source{ok})
			okAgg.Refresh(t.Context())
			require.True(t, okAgg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "me", "a", "me/a"))
			assert.Equal(t, 1, ok.repoFetchCallCount("me/a"), "above it the refresh runs")
		})
	}
}

// The newest figure the forge gave is the one that counts, and the board shows
// it for a full refresh held because of it.
func TestReserve_ScheduledRefresh_HeldByANewerBudget_ShowsTheNewerOne(t *testing.T) {
	t.Parallel()

	src := &liveBudgetSource{budgetSource: newBudgetSource(graphQL, 5000)}
	timer := newFakeRunTimer()
	agg := dashboard.NewAggregator([]dashboard.Source{src}, timer.option())
	timer.start(t, agg, time.Hour)
	src.report(&dashboard.RateLimit{Limit: 5000, Remaining: reserved, ResetsAt: src.resets})

	timer.tick(t)

	require.Equal(t, 1, src.fetchCallCount(), "the scheduled refresh is held")
	require.Len(t, agg.Get().Forges, 1)
	require.NotNil(t, agg.Get().Forges[0].RateLimitGraphQL)
	assert.Equal(t, reserved, agg.Get().Forges[0].RateLimitGraphQL.Remaining)
}

// liveBudgetSource also reports a budget between full refreshes.
type liveBudgetSource struct {
	*budgetSource

	latest atomic.Pointer[dashboard.RateLimit]
}

func (s *liveBudgetSource) report(rl *dashboard.RateLimit) { s.latest.Store(rl) }

func (s *liveBudgetSource) LatestBudgets(string, string) (gql, restBudget *dashboard.RateLimit) {
	return s.latest.Load(), nil
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

	src := newBudgetSource(graphQL, reserved)
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
