package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeCreds struct{}

func (fakeCreds) EnsureWebhookCredentials(context.Context, []byte) (string, string, error) {
	return "tok", "sekret", nil
}

// fakeUpgradeSource reports repos and records every UpgradeWebhook call.
type fakeUpgradeSource struct {
	fakeSource

	mu      sync.Mutex
	urls    map[string]string // "owner/name" -> target URL
	calls   []string
	results map[string]error // by "owner/name"
	updated bool
}

func (f *fakeUpgradeSource) UpgradeWebhook(_ context.Context, owner, name, targetURL, _ string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := owner + "/" + name
	f.calls = append(f.calls, key)
	if f.urls == nil {
		f.urls = map[string]string{}
	}
	f.urls[key] = targetURL

	return f.updated, f.results[key]
}

func (f *fakeUpgradeSource) called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.calls...)
}

func upgradeSource(health dashboard.ForgeHealth, repos ...dashboard.Repo) *fakeUpgradeSource {
	src := &fakeUpgradeSource{updated: true}
	src.result = dashboard.Result{Health: health, Repos: repos}

	return src
}

func covered(forge dashboard.Forge, names ...string) []dashboard.Repo {
	repos := make([]dashboard.Repo, 0, len(names))
	for _, n := range names {
		repos = append(repos, dashboard.Repo{Forge: forge, FullName: n, HasWebhook: true})
	}

	return repos
}

func upgradingAggregator(t *testing.T, state *dashboard.WebhookUpgrades, srcs ...dashboard.Source) *dashboard.Aggregator {
	t.Helper()
	agg := dashboard.NewAggregator(srcs)
	agg.EnableWebhookUpgrade(t.Context(), []byte("u1"), fakeCreds{}, "https://dash.example", state)

	return agg
}

func refreshAndWait(t *testing.T, agg *dashboard.Aggregator) {
	t.Helper()
	agg.Refresh(t.Context())
	agg.WaitWebhookUpgrade()
}

func TestWebhookUpgrade_CoveredRepo_IsUpgradedAtTheOwnTargetURL(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	// A repo without our hook is never touched: creating one is the button's job.
	src.result.Repos = append(src.result.Repos, dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "me/bare"})

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Equal(t, []string{"me/a"}, src.called())
	assert.Equal(t, "https://dash.example/api/webhooks/github/tok", src.urls["me/a"])
}

func TestWebhookUpgrade_SecondRefreshAndSecondAggregator_DoNothing(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true}, covered(dashboard.ForgeForgejo, "me/a")...)
	src.updated = false
	state := dashboard.NewWebhookUpgrades(0)
	agg := upgradingAggregator(t, state, src)

	refreshAndWait(t, agg)
	refreshAndWait(t, agg)
	// Saving credentials rebuilds the aggregator; the process-wide state
	// still remembers the repo.
	refreshAndWait(t, upgradingAggregator(t, state, src))

	assert.Equal(t, []string{"me/a"}, src.called())
}

func TestWebhookUpgrade_ExhaustedRestBudget_SkipsTheForgeUntilItRecovers(t *testing.T) {
	t.Parallel()

	health := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RateLimitREST: &dashboard.RateLimit{Limit: 5000, Remaining: 0}}
	src := upgradeSource(health, covered(dashboard.ForgeGitHub, "me/a")...)
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)
	assert.Empty(t, src.called())
	assert.True(t, agg.Get().Forges[0].Reachable, "the refresh itself is unharmed")

	src.result.Health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: 4000}
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/a"}, src.called())
}

func TestWebhookUpgrade_UnreachableForge_IsSkipped(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false}, covered(dashboard.ForgeForgejo, "me/a")...)

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Empty(t, src.called())
}

func TestWebhookUpgrade_RateLimitedAnswer_StopsTheForgeAndRetriesOnTheNextRefresh(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	src.results = map[string]error{"me/a": &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("rate limited")}}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/a"}, src.called())
	assert.Len(t, agg.Get().Repos, 1, "the refresh still succeeded")

	src.mu.Lock()
	src.results = nil
	src.mu.Unlock()
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/a", "me/a"}, src.called())
}

func TestWebhookUpgrade_NoAdminRight_IsTriedOnceAndNotAgain(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a", "me/b")...)
	src.results = map[string]error{"me/a": &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403")}}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)
	refreshAndWait(t, agg)

	assert.ElementsMatch(t, []string{"me/a", "me/b"}, src.called(), "one listing each; the refusal does not stop the other repo")
}

func TestWebhookUpgrade_NotEnabled_DoesNothing(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context())
	agg.WaitWebhookUpgrade()

	require.Empty(t, src.called())
}

func TestManager_SetWebhookUpgrade_EnablesItOnTheAggregatorsItBuilds(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	mgr := dashboard.NewManager(time.Hour)
	t.Cleanup(mgr.Stop)
	mgr.SetWebhookUpgrade(fakeCreds{}, "https://dash.example")

	mgr.Ensure(t.Context(), []byte("u1"), []dashboard.Source{src})

	assert.Eventually(t, func() bool { return len(src.called()) == 1 }, 5*time.Second, 10*time.Millisecond)
}
