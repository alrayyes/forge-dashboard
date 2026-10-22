package dashboard_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStretchedInterval(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		interval time.Duration
		want     time.Duration
	}{
		{"the default stretches to 80 minutes", 20 * time.Minute, 80 * time.Minute},
		{"four times is capped at two hours", 45 * time.Minute, 2 * time.Hour},
		{"a value already past the cap is never shortened", 3 * time.Hour, 3 * time.Hour},
		{"a value at the cap stays", 2 * time.Hour, 2 * time.Hour},
		{"a short value still stretches four times", time.Minute, 4 * time.Minute},
		{"a value too large to multiply is kept, not wrapped negative", 1000000 * time.Hour, 1000000 * time.Hour},
		{"the largest duration is kept", time.Duration(math.MaxInt64), time.Duration(math.MaxInt64)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tt.want, dashboard.StretchedInterval(tt.interval))
		})
	}
}

func refreshedWith(t *testing.T, health dashboard.ForgeHealth, repos ...dashboard.Repo) *dashboard.Aggregator {
	t.Helper()

	health.Forge = dashboard.ForgeGitHub
	health.Reachable = true
	src := &fakeSource{result: dashboard.Result{Health: health, Repos: repos}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, len(repos))

	return agg
}

func repoWithHook(name string, has bool) dashboard.Repo {
	return dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: name, HasWebhook: has}
}

func runCount(t *testing.T, repos []dashboard.Repo, interval, wait time.Duration) int {
	t.Helper()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  repos,
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan struct{})
	go func() {
		agg.Run(ctx, interval)
		close(done)
	}()

	time.Sleep(wait)
	cancel()
	<-done

	return src.callCount()
}

func TestAggregator_Run_WaitsTheStretchedDelayWhileEveryWebhookIsHealthy(t *testing.T) {
	t.Parallel()

	// Stretched, the wait is 80ms: only Run's refresh on entry fits in 60ms.
	got := runCount(t, []dashboard.Repo{repoWithHook("alrayyes/a", true)}, 20*time.Millisecond, 60*time.Millisecond)

	assert.Equal(t, 1, got)
}

func TestAggregator_Run_KeepsTheIntervalWhenAWebhookIsMissing(t *testing.T) {
	t.Parallel()

	got := runCount(t, []dashboard.Repo{repoWithHook("alrayyes/a", false)}, 20*time.Millisecond, 70*time.Millisecond)

	assert.GreaterOrEqual(t, got, 3)
}

func TestAggregator_NextDelay_StretchesWhileEveryWebhookIsHealthy(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true), repoWithHook("o/b", true))

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_ReturnsToTheIntervalWhenOneWebhookIsUnhealthy(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true), repoWithHook("o/b", false))

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_NoReposIsNotCovered(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{})

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_AnExplicitLongIntervalIsTheLowerBound(t *testing.T) {
	t.Parallel()

	agg := refreshedWith(t, dashboard.ForgeHealth{}, repoWithHook("o/a", true))

	assert.Equal(t, 3*time.Hour, agg.NextDelay(3*time.Hour))
}

func TestAggregator_NextDelay_StillWaitsOutACriticalBudget(t *testing.T) {
	t.Parallel()

	health := dashboard.ForgeHealth{
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 10, ResetsAt: time.Now().Add(10 * time.Hour)},
	}
	covered := refreshedWith(t, health, repoWithHook("o/a", true))
	uncovered := refreshedWith(t, health, repoWithHook("o/a", false))

	// The budget's wait (capped at an hour) passes through unchanged: it is
	// longer than the plain interval, shorter than the stretched one.
	assert.Equal(t, time.Hour, uncovered.NextDelay(20*time.Minute))
	assert.Equal(t, 80*time.Minute, covered.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_DoesNotStretchWhileAForgeFetchFails(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))

	// The whole fetch fails: the repos are the earlier ones, which say
	// nothing about now.
	setResult(src, dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false}})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, 1)

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_DoesNotStretchWhileAnotherForgeWasNeverReachable(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_DoesNotStretchOnASnapshotRestoredAtStart(t *testing.T) {
	t.Parallel()

	cache := &memSnapshotCache{}
	src := func() dashboard.Source {
		return &fakeSource{result: dashboard.Result{
			Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
			Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
		}}
	}
	first := dashboard.NewAggregator([]dashboard.Source{src()}, dashboard.WithSnapshotCache(cache))
	first.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, first.NextDelay(20*time.Minute))

	// The saved hook state is from before the restart. Until a refresh has
	// reached the forge it says nothing about now.
	restarted := dashboard.NewAggregator([]dashboard.Source{src()}, dashboard.WithSnapshotCache(cache))
	require.Len(t, restarted.Get().Repos, 1)

	assert.Equal(t, 20*time.Minute, restarted.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_DoesNotStretchWhileARepoIsInFailedRepos(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/b", PullRequests: true}},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))

	setResult(src, dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
	})
	agg.Refresh(t.Context())

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func TestAggregator_NextDelay_StretchesAgainOnceARepoHasFailedForThreeIntervals(t *testing.T) {
	t.Parallel()

	const interval = 200 * time.Millisecond

	healthy := dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true), repoWithHook("o/b", true)},
	}
	failing := healthy
	failing.FailedRepos = []dashboard.FailedRepo{{FullName: "o/b", Issues: true}}

	src := &fakeSource{result: healthy}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	setResult(src, failing)
	agg.Refresh(t.Context())
	require.Equal(t, interval, agg.NextDelay(interval), "a fresh failure keeps the short wait")

	time.Sleep(3*interval + 100*time.Millisecond)
	agg.Refresh(t.Context())

	assert.Equal(t, 4*interval, agg.NextDelay(interval), "a repo that keeps failing stops holding it")
}

func TestAggregator_NextDelay_AFirstEverFailureIsNotYetPermanent(t *testing.T) {
	t.Parallel()

	src := &fakeSource{result: dashboard.Result{
		Health:      dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:       []dashboard.Repo{repoWithHook("o/a", true)},
		FailedRepos: []dashboard.FailedRepo{{FullName: "o/a", Issues: true}},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))
}

// Pins the forge-health gate in webhooksCover, which predates the failed-repo
// check: a restored or failed forge is already Reachable:false, so this passes
// without that check.
func TestAggregator_NextDelay_OnlyTheFailedForgeBlocksCoverageAndItRecovers(t *testing.T) {
	t.Parallel()

	gh := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  []dashboard.Repo{repoWithHook("o/a", true)},
	}}
	fjRepo := dashboard.Repo{Forge: dashboard.ForgeForgejo, FullName: "o/b", HasWebhook: true}
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{fjRepo},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})
	agg.Refresh(t.Context())
	require.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))

	// Forgejo's fetch fails: GitHub is fully covered, but Forgejo's repo is
	// carried over, so the short wait holds while it is down.
	down := dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false}}
	setResult(fj, down)
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().Repos, 2)
	assert.Equal(t, 20*time.Minute, agg.NextDelay(20*time.Minute))

	setResult(fj, dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{fjRepo},
	})
	agg.Refresh(t.Context())

	assert.Equal(t, 80*time.Minute, agg.NextDelay(20*time.Minute))
}

func setResult(src *fakeSource, res dashboard.Result) {
	src.mu.Lock()
	defer src.mu.Unlock()
	src.result = res
}
