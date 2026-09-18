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

type fakeSource struct {
	result dashboard.Result
	mu     sync.Mutex
	calls  int
}

func (f *fakeSource) Fetch(_ context.Context) dashboard.Result {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.result
}

func (f *fakeSource) Forge() dashboard.Forge { return f.result.Health.Forge }

func (f *fakeSource) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestAggregator_GetBeforeRefresh_ReturnsEmptyNotNil(t *testing.T) {
	t.Parallel()

	agg := dashboard.NewAggregator(nil)

	snap := agg.Get()

	require.NotNil(t, snap.PullRequests)
	require.NotNil(t, snap.Issues)
	require.NotNil(t, snap.Forges)
	require.NotNil(t, snap.Repos)
	assert.Empty(t, snap.PullRequests)
	assert.Empty(t, snap.Issues)
	assert.Empty(t, snap.Repos)
}

func TestAggregator_Refresh_MergesAllSources(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
		Issues:       []dashboard.Issue{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2}},
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"}},
	}}
	fj := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 3}},
		Issues:       []dashboard.Issue{{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 4}},
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeForgejo, FullName: "alrayyes/b"}},
	}}

	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())

	snap := agg.Get()

	t.Run("pull requests from both sources", func(t *testing.T) {
		t.Parallel()
		assert.Len(t, snap.PullRequests, 2)
	})
	t.Run("issues from both sources", func(t *testing.T) {
		t.Parallel()
		assert.Len(t, snap.Issues, 2)
	})
	t.Run("a health entry per source", func(t *testing.T) {
		t.Parallel()
		assert.Len(t, snap.Forges, 2)
	})
	t.Run("repos from both sources", func(t *testing.T) {
		t.Parallel()
		assert.ElementsMatch(t, []dashboard.Repo{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a"},
			{Forge: dashboard.ForgeForgejo, FullName: "alrayyes/b"},
		}, snap.Repos)
	})
	t.Run("generatedAt is recent", func(t *testing.T) {
		t.Parallel()
		assert.WithinDuration(t, time.Now(), snap.GeneratedAt, time.Minute)
	})
}

func TestAggregator_Refresh_OneSourceUnreachable_OthersStillReported(t *testing.T) {
	t.Parallel()

	broken := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false, Error: "dial tcp: timeout"},
	}}
	healthy := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 5},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
	}}

	agg := dashboard.NewAggregator([]dashboard.Source{broken, healthy})
	agg.Refresh(t.Context())

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 1, "the healthy source's data should still appear")

	var forgejoHealth *dashboard.ForgeHealth
	for i := range snap.Forges {
		if snap.Forges[i].Forge == dashboard.ForgeForgejo {
			forgejoHealth = &snap.Forges[i]
		}
	}
	require.NotNil(t, forgejoHealth, "expected a forgejo health entry even though it failed")
	assert.False(t, forgejoHealth.Reachable)
	assert.NotEmpty(t, forgejoHealth.Error)
}

func TestAggregator_Subscribe_NotifiedOnRefresh(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	updates, unsubscribe := agg.Subscribe()
	defer unsubscribe()

	agg.Refresh(t.Context())

	select {
	case snap := <-updates:
		assert.Len(t, snap.PullRequests, 1)
	case <-time.After(time.Second):
		t.Fatal("expected a snapshot on the subscription channel after Refresh")
	}
}

func TestAggregator_Unsubscribe_StopsDelivery(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	updates, unsubscribe := agg.Subscribe()
	unsubscribe()

	agg.Refresh(t.Context())

	_, stillOpen := <-updates
	assert.False(t, stillOpen, "the channel should be closed once unsubscribed, and never receive a late delivery")
}

func TestAggregator_Subscribe_SlowConsumerDoesNotBlockRefresh(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	_, unsubscribe := agg.Subscribe() // never read from — a subscriber that fell behind
	defer unsubscribe()

	done := make(chan struct{})
	go func() {
		agg.Refresh(t.Context())
		agg.Refresh(t.Context()) // a second refresh with the buffer already full
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Refresh blocked on a subscriber that never reads its channel")
	}
}

func TestAggregator_Run_RefreshesOnIntervalUntilCanceled(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 10*time.Millisecond)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after context cancellation")
	}

	assert.GreaterOrEqual(t, src.callCount(), 2, "expected multiple refreshes over 50ms at a 10ms interval")
}

// TestAggregator_Run_CriticallyLowBudget_DelaysNextRefresh is the backoff
// regression test #381's own definition of done calls for: a fixed-ticker
// Run firing on schedule into an already-exhausted budget is what turns
// one rate-limit hit into a recurring one, so a critically low budget
// (reported by the source's own Result, the same shape a real GitHub
// client reports) has to push the next refresh out past its own reset
// instead of firing at the normal fast interval.
func TestAggregator_Run_CriticallyLowBudget_DelaysNextRefresh(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:     dashboard.ForgeGitHub,
			Reachable: true,
			RateLimitREST: &dashboard.RateLimit{
				Limit: 5000, Remaining: 10, // <1%, well under the 5% critical threshold
				ResetsAt: time.Now().Add(time.Hour), // far beyond this test's own patience
			},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, 10*time.Millisecond)
		close(done)
	}()

	// At the normal 10ms interval this would see 5+ calls; backed off
	// against an hour-away reset, it should still be sitting at the one
	// immediate refresh Run always does on entry.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after context cancellation")
	}

	assert.Equal(t, 1, src.callCount(), "a critically low budget should have suppressed every scheduled refresh after the initial one")
}

func TestNextRefreshDelay(t *testing.T) {
	t.Parallel()

	const interval = time.Minute

	t.Run("no rate limit reported", func(t *testing.T) {
		t.Parallel()
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{Forge: dashboard.ForgeGitHub}}}
		assert.Equal(t, interval, dashboard.NextRefreshDelay(snap, interval))
	})

	t.Run("healthy budget", func(t *testing.T) {
		t.Parallel()
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
			Forge:         dashboard.ForgeGitHub,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 4000, ResetsAt: time.Now().Add(time.Hour)},
		}}}
		assert.Equal(t, interval, dashboard.NextRefreshDelay(snap, interval))
	})

	t.Run("critically low budget delays until its own reset", func(t *testing.T) {
		t.Parallel()
		resetsAt := time.Now().Add(2 * time.Minute)
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
			Forge:         dashboard.ForgeGitHub,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 10, ResetsAt: resetsAt},
		}}}
		got := dashboard.NextRefreshDelay(snap, interval)
		assert.Greater(t, got, interval)
		assert.LessOrEqual(t, got, time.Until(resetsAt)+time.Minute)
	})

	t.Run("reset already in the past never shortens the interval", func(t *testing.T) {
		t.Parallel()
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
			Forge:         dashboard.ForgeGitHub,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 1, ResetsAt: time.Now().Add(-time.Hour)},
		}}}
		assert.Equal(t, interval, dashboard.NextRefreshDelay(snap, interval))
	})

	t.Run("a far-future reset is capped rather than stalling indefinitely", func(t *testing.T) {
		t.Parallel()
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
			Forge:         dashboard.ForgeGitHub,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: time.Now().Add(24 * time.Hour)},
		}}}
		got := dashboard.NextRefreshDelay(snap, interval)
		assert.LessOrEqual(t, got, time.Hour)
		assert.Greater(t, got, interval)
	})

	t.Run("the worse of two budgets wins", func(t *testing.T) {
		t.Parallel()
		soon := time.Now().Add(90 * time.Second)
		later := time.Now().Add(10 * time.Minute)
		snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
			Forge:            dashboard.ForgeGitHub,
			RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 10, ResetsAt: soon},
			RateLimitREST:    &dashboard.RateLimit{Limit: 5000, Remaining: 5, ResetsAt: later},
		}}}
		got := dashboard.NextRefreshDelay(snap, interval)
		assert.GreaterOrEqual(t, got, time.Until(later))
	})
}
