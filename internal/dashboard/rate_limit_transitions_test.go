package dashboard_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// withCapturedLogs swaps the global slog default for a handler writing to
// buf at Info level, restoring the previous default on cleanup — the same
// pattern internal/api/access_log_test.go's own withCapturedLogs uses,
// minus its level parameter (this package's tests only ever need Info).
// Not t.Parallel(): it mutates global state.
func withCapturedLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return &logs
}

func TestAggregator_Refresh_BudgetBecomesExhausted_LogsAWarning(t *testing.T) {
	logs := withCapturedLogs(t)

	resetsAt := time.Now().Add(time.Hour).UTC()
	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:            dashboard.ForgeGitHub,
			Reachable:        true,
			RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 40, ResetsAt: resetsAt},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	assert.Empty(t, logs.String(), "not exhausted yet — nothing to log")

	src.result.Health.RateLimitGraphQL = &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resetsAt}
	agg.Refresh(t.Context())

	logged := logs.String()
	assert.Contains(t, logged, "level=WARN")
	assert.Contains(t, logged, "rate limit exhausted")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "kind=graphql")
	assert.Contains(t, logged, "limit=5000")
}

func TestAggregator_Refresh_BudgetRecovers_LogsAnInfo(t *testing.T) {
	logs := withCapturedLogs(t)

	resetsAt := time.Now().Add(time.Hour).UTC()
	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:         dashboard.ForgeGitHub,
			Reachable:     true,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resetsAt},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.result.Health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: 5000, ResetsAt: resetsAt.Add(time.Hour)}
	agg.Refresh(t.Context())

	logged := logs.String()
	assert.Contains(t, logged, "level=INFO")
	assert.Contains(t, logged, "rate limit refreshed")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "kind=rest")
	assert.Contains(t, logged, "remaining=5000")
}

func TestAggregator_Refresh_StillExhausted_LogsOnlyOnce(t *testing.T) {
	logs := withCapturedLogs(t)

	resetsAt := time.Now().Add(time.Hour).UTC()
	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:         dashboard.ForgeGitHub,
			Reachable:     true,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resetsAt},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Equal(t, 1, strings.Count(logs.String(), "rate limit exhausted"), "an already-exhausted budget must not re-log on every poll")
}

func TestAggregator_Refresh_FirstEverPollAlreadyExhausted_StillLogs(t *testing.T) {
	logs := withCapturedLogs(t)

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:         dashboard.ForgeGitHub,
			Reachable:     true,
			RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: time.Now().Add(time.Hour).UTC()},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	assert.Contains(t, logs.String(), "rate limit exhausted")
}

func TestAggregator_Refresh_RESTAndGraphQLTrackedIndependently(t *testing.T) {
	logs := withCapturedLogs(t)

	resetsAt := time.Now().Add(time.Hour).UTC()
	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:            dashboard.ForgeGitHub,
			Reachable:        true,
			RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 2500, ResetsAt: resetsAt},
			RateLimitREST:    &dashboard.RateLimit{Limit: 5000, Remaining: 2500, ResetsAt: resetsAt},
		},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	src.result.Health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resetsAt}
	agg.Refresh(t.Context())

	logged := logs.String()
	assert.Contains(t, logged, "kind=rest")
	assert.NotContains(t, logged, "kind=graphql", "GraphQL never moved — only REST's transition should log")
}

func TestAggregator_Refresh_NilReading_NeverCountsAsATransition(t *testing.T) {
	logs := withCapturedLogs(t)

	src := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Empty(t, logs.String(), "no RateLimit data at all on either poll — nothing to compare")
}
