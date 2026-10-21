package dashboard_test

import (
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
