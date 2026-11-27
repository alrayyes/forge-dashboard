package dashboard_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// costlySource reports a GraphQL cost for every one-repo fetch, as GitHub does.
type costlySource struct {
	*budgetSource

	cost  int
	stats *apistats.Counters
	// ackCost is what asking about a bot request costs, and acks how often it
	// was asked.
	ackCost int
	acks    atomic.Int32
}

func (s *costlySource) FetchRepo(ctx context.Context, owner, name, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	s.stats.AddCost(ctx, string(dashboard.ForgeGitHub), "token", s.cost)

	return s.budgetSource.FetchRepo(ctx, owner, name, fullName)
}

type costFixture struct {
	t     *testing.T
	clock *fakeTimers
	src   *costlySource
	agg   *dashboard.Aggregator
}

// newCostFixture is an Aggregator with a 5000 point budget, nearly all of it
// left, over a source whose one-repo fetch costs cost points.
func newCostFixture(t *testing.T, cost int) *costFixture {
	t.Helper()

	clock := newFakeTimers()
	src := &costlySource{budgetSource: newBudgetSource(graphQL, 5000), cost: cost, stats: apistats.New()}
	src.resets = clock.Now().Add(2 * time.Hour)
	src.setRepo("me/b", nil)
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithClock(clock.Now), dashboard.WithDebounceTimer(clock.After))
	agg.Refresh(t.Context())

	return &costFixture{t: t, clock: clock, src: src, agg: agg}
}

func (f *costFixture) event(name string) {
	f.t.Helper()
	require.True(f.t, f.agg.RefreshRepoDebounced(f.t.Context(), dashboard.ForgeGitHub, "me", name, "me/"+name))
}

// A repository whose events never stop may spend a tenth of the hourly budget
// on them, and no more.
func TestWebhookCost_ABurstForOneRepo_SpendsATenthOfTheBudgetAnHour(t *testing.T) {
	t.Parallel()
	const cost, tenth = 20, 500
	f := newCostFixture(t, cost)

	for range 360 {
		f.event("a")
		f.clock.Advance(10 * time.Second)
	}

	spent := cost * f.src.repoFetchCallCount("me/a")
	assert.LessOrEqual(t, spent, tenth+cost, "the share, plus the refresh that started it")
	assert.GreaterOrEqual(t, spent, tenth*8/10, "and the share is used, not starved")
}

// The delivery that has to wait is not lost, and other repositories don't wait
// with it.
func TestWebhookCost_ADeliveryAfterACostlyRefresh_RunsWhenItIsPaidFor(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 20) // 144 seconds of the share
	f.event("a")
	f.clock.Advance(2 * time.Second)

	f.event("a")
	f.event("b")
	f.clock.Advance(100 * time.Second)
	require.Equal(t, 1, f.src.repoFetchCallCount("me/a"), "still paying for the last one")
	assert.Equal(t, 1, f.src.repoFetchCallCount("me/b"))
	f.clock.Advance(44 * time.Second)

	assert.Equal(t, 2, f.src.repoFetchCallCount("me/a"))
}

func TestWebhookCost_ACheapRefresh_KeepsTheMinimumInterval(t *testing.T) {
	t.Parallel()
	f := newCostFixture(t, 1)
	f.event("a")
	f.clock.Advance(2 * time.Second)

	f.event("a")
	f.clock.Advance(30 * time.Second)

	assert.Equal(t, 2, f.src.repoFetchCallCount("me/a"))
}
