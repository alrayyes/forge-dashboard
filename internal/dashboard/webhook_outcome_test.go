package dashboard_test

import (
	"errors"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func bareGitHubSource(err error) *fakeUpgradeSource {
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	if err != nil {
		src.ensureResults = map[string]error{"me/bare": err}
	}

	return src
}

func TestWebhookOutcome_RefusedRepo_SaysWhyAndWhenItIsAskedAgain(t *testing.T) {
	t.Parallel()

	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403")})
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	state := dashboard.NewWebhookUpgrades(0).WithRetry(time.Hour, func() time.Time { return now })

	refreshAndWait(t, upgradingAggregator(t, state, src))

	got, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	require.True(t, ok)
	assert.Equal(t, dashboard.WebhookRefused, got.Reason)
	assert.NotEmpty(t, got.Detail)
	assert.Equal(t, now.Add(time.Hour), got.NextAttempt)
}

func TestWebhookOutcome_RateLimitedForge_IsUnavailableNotRefused(t *testing.T) {
	t.Parallel()

	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("rate limited")})
	state := dashboard.NewWebhookUpgrades(0)

	refreshAndWait(t, upgradingAggregator(t, state, src))

	got, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	require.True(t, ok)
	assert.Equal(t, dashboard.WebhookUnavailable, got.Reason)
}

func TestWebhookOutcome_UnreachableForgeAnswer_IsUnavailable(t *testing.T) {
	t.Parallel()

	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: errors.New("dial")})
	state := dashboard.NewWebhookUpgrades(0)

	refreshAndWait(t, upgradingAggregator(t, state, src))

	got, _ := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.Equal(t, dashboard.WebhookUnavailable, got.Reason)
}

func TestWebhookOutcome_HookCreatedLater_ClearsTheReason(t *testing.T) {
	t.Parallel()

	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("rate limited")})
	state := dashboard.NewWebhookUpgrades(0)
	agg := upgradingAggregator(t, state, src)

	refreshAndWait(t, agg)
	src.mu.Lock()
	src.ensureResults = nil
	src.mu.Unlock()
	refreshAndWait(t, agg)

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}

func TestWebhookOutcome_FailureThatIsNotAForgeAnswer_IsNotARefusal(t *testing.T) {
	t.Parallel()

	state := dashboard.NewWebhookUpgrades(0)

	refreshAndWait(t, upgradingAggregator(t, state, bareGitHubSource(errors.New("parse target URL"))))

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}

func TestForgeServesHookWork(t *testing.T) {
	t.Parallel()

	assert.True(t, dashboard.ForgeServesHookWork(dashboard.ForgeHealth{Reachable: true}))
	assert.False(t, dashboard.ForgeServesHookWork(dashboard.ForgeHealth{Reachable: false}))
	assert.False(t, dashboard.ForgeServesHookWork(dashboard.ForgeHealth{Reachable: true, RateLimitREST: &dashboard.RateLimit{Remaining: 0}}))
}

func TestService_WebhookOutcome_IsEmptyWithoutAnUpgradeState(t *testing.T) {
	t.Parallel()

	var svc dashboard.Service
	_, ok := svc.WebhookOutcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}
