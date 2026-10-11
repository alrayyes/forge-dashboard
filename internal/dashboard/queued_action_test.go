package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestQueueableAction_OnlyTheSafeIdempotentOnes(t *testing.T) {
	t.Parallel()

	for _, a := range []dashboard.ActionName{dashboard.ActionUpdateBranch, dashboard.ActionDependabotRebase, dashboard.ActionRenovateRebase} {
		assert.True(t, dashboard.QueueableAction(a), a)
	}
	for _, a := range []dashboard.ActionName{
		dashboard.ActionMerge, dashboard.ActionClose, dashboard.ActionAutoMerge, dashboard.ActionCancelAutoMerge,
		dashboard.ActionDependabotRecreate, dashboard.ActionRerunChecks, "nonsense", "",
	} {
		assert.False(t, dashboard.QueueableAction(a), a)
	}
}

func TestRateLimitedUntil(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 10, 11, 14, 0, 0, 0, time.UTC)
	spent := func(reset time.Time) *dashboard.RateLimit {
		return &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset}
	}
	healthy := &dashboard.RateLimit{Limit: 5000, Remaining: 4000, ResetsAt: now.Add(time.Hour)}
	snap := func(rest, graphql *dashboard.RateLimit) dashboard.Snapshot {
		return dashboard.Snapshot{Forges: []dashboard.ForgeHealth{
			{Forge: dashboard.ForgeGitHub, RateLimitREST: rest, RateLimitGraphQL: graphql},
			{Forge: dashboard.ForgeForgejo, RateLimitREST: healthy},
		}}
	}

	t.Run("a spent budget answers its reset", func(t *testing.T) {
		t.Parallel()
		at, ok := dashboard.RateLimitedUntil(snap(spent(now.Add(10*time.Minute)), nil), dashboard.ForgeGitHub, now)
		assert.True(t, ok)
		assert.Equal(t, now.Add(10*time.Minute), at)
	})
	t.Run("two spent budgets answer the later reset, since a re-check needs both", func(t *testing.T) {
		t.Parallel()
		at, ok := dashboard.RateLimitedUntil(snap(spent(now.Add(10*time.Minute)), spent(now.Add(40*time.Minute))), dashboard.ForgeGitHub, now)
		assert.True(t, ok)
		assert.Equal(t, now.Add(40*time.Minute), at)
	})
	t.Run("a healthy forge is not limited", func(t *testing.T) {
		t.Parallel()
		_, ok := dashboard.RateLimitedUntil(snap(healthy, healthy), dashboard.ForgeGitHub, now)
		assert.False(t, ok)
		_, ok = dashboard.RateLimitedUntil(snap(spent(now.Add(time.Minute)), nil), dashboard.ForgeForgejo, now)
		assert.False(t, ok)
	})
	t.Run("a reset already passed is not limited", func(t *testing.T) {
		t.Parallel()
		_, ok := dashboard.RateLimitedUntil(snap(spent(now.Add(-time.Second)), nil), dashboard.ForgeGitHub, now)
		assert.False(t, ok)
	})
	t.Run("a budget with no limit reported is not limited", func(t *testing.T) {
		t.Parallel()
		_, ok := dashboard.RateLimitedUntil(snap(&dashboard.RateLimit{}, nil), dashboard.ForgeGitHub, now)
		assert.False(t, ok)
	})
}
