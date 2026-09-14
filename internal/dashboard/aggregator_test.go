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
	assert.Empty(t, snap.PullRequests)
	assert.Empty(t, snap.Issues)
}

func TestAggregator_Refresh_MergesAllSources(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}},
		Issues:       []dashboard.Issue{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2}},
	}}
	fj := &fakeSource{result: dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 3}},
		Issues:       []dashboard.Issue{{Forge: dashboard.ForgeForgejo, Repo: "alrayyes/b", Number: 4}},
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
