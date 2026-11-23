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

	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("Resource not accessible by integration")})
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC)
	state := dashboard.NewWebhookUpgrades(0).WithRetry(time.Hour, func() time.Time { return now })

	refreshAndWait(t, upgradingAggregator(t, state, src))

	got, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	require.True(t, ok)
	assert.Equal(t, dashboard.WebhookRefused, got.Reason)
	assert.Equal(t, "Resource not accessible by integration", got.Detail)
	assert.Equal(t, now.Add(time.Hour), got.NextAttempt)
}

// Detail is the forge's own words or nothing, so the page never credits the
// forge with a sentence the dashboard wrote.
func TestWebhookOutcome_RefusalDetail_IsOnlyWhatTheForgeSaid(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		err  error
		want string
	}{
		"a plain sentence from the forge is carried": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New("Hook limit reached for this repository")},
			"Hook limit reached for this repository",
		},
		"a refusal with no text has no detail": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New("")},
			"",
		},
		"a bare status line is not the forge's words": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403")},
			"",
		},
		"a repo the forge can't find has no detail": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorNotFound, Err: errors.New("404")},
			"",
		},
		"a JSON body is not a sentence": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New(`{"message":"nope"}`)},
			"",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			state := dashboard.NewWebhookUpgrades(0)
			refreshAndWait(t, upgradingAggregator(t, state, bareGitHubSource(tc.err)))

			got, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
			require.True(t, ok)
			assert.Equal(t, dashboard.WebhookRefused, got.Reason)
			assert.Equal(t, tc.want, got.Detail)
		})
	}
}

func refusedState(t *testing.T) (*dashboard.WebhookUpgrades, *fakeUpgradeSource) {
	t.Helper()
	src := bareGitHubSource(&dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: errors.New("Hook limit reached")})
	state := dashboard.NewWebhookUpgrades(0)
	refreshAndWait(t, upgradingAggregator(t, state, src))
	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	require.True(t, ok)

	return state, src
}

func TestWebhookOutcome_RepoThatLeavesTheSnapshot_IsForgotten(t *testing.T) {
	t.Parallel()

	state, src := refusedState(t)
	src.result.Repos = nil
	refreshAndWait(t, upgradingAggregator(t, state, src))

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}

func TestWebhookOutcome_RepoThatGainsAHookElsewhere_IsForgotten(t *testing.T) {
	t.Parallel()

	state, src := refusedState(t)
	src.result.Repos = covered(dashboard.ForgeGitHub, "me/bare")
	refreshAndWait(t, upgradingAggregator(t, state, src))

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}

func TestWebhookOutcome_OriginThatTurnsUnusable_DropsTheNextTryPromise(t *testing.T) {
	t.Parallel()

	state, src := refusedState(t)
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableWebhookUpgrade(t.Context(), fakeCreds{}, "http://localhost", state)
	refreshAndWait(t, agg)

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.False(t, ok)
}

func TestWebhookOutcome_ForgeThatIsDown_KeepsItsRepoOutcomes(t *testing.T) {
	t.Parallel()

	state, src := refusedState(t)
	src.result.Repos = nil
	src.result.Health.Reachable = false
	refreshAndWait(t, upgradingAggregator(t, state, src))

	_, ok := state.Outcome(dashboard.ForgeGitHub, "me/bare")
	assert.True(t, ok)
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
