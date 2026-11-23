package dashboard_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeCreds struct{}

func (fakeCreds) EnsureWebhookCredentials(context.Context) (string, string, error) {
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

	ensured       []string
	ensureResults map[string]error
	ensureHold    time.Duration
	inflight      atomic.Int32
	peak          atomic.Int32
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
	agg.EnableWebhookUpgrade(t.Context(), fakeCreds{}, "https://dash.example", state)

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
	// A repo without our hook is never upgraded: it is created, not listed.
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

func TestWebhookUpgrade_UpstreamErrorAnswer_IsRetriedOnTheNextRefresh(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	src.results = map[string]error{"me/a": &dashboard.ClientError{Kind: dashboard.ForgeErrorUpstream, Err: errors.New("502")}}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)
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

func TestWebhookUpgrade_CoveredRepo_IsCheckedAgainAfterTheRetryWait(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	var offset atomic.Int64
	clock := func() time.Time {
		return time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC).Add(time.Duration(offset.Load()))
	}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0).WithRetry(time.Hour, clock), src)

	refreshAndWait(t, agg)
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/a"}, src.called(), "not listed again inside the wait")

	// A hook switched off since the first pass is found and repaired on the
	// next pass after the wait, with no restart.
	offset.Store(int64(2 * time.Hour))
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/a", "me/a"}, src.called())
}

func TestWebhookUpgrade_NotEnabled_DoesNothing(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	agg.Refresh(t.Context())
	agg.WaitWebhookUpgrade()

	require.Empty(t, src.called())
}

func TestService_SetWebhookUpgrade_EnablesItOnTheAggregatorsItBuilds(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	mgr := dashboard.NewService(time.Hour)
	t.Cleanup(mgr.Stop)
	mgr.SetWebhookUpgrade(fakeCreds{}, "https://dash.example")

	mgr.Ensure(t.Context(), []dashboard.Source{src})

	assert.Eventually(t, func() bool { return len(src.called()) == 1 }, 5*time.Second, 10*time.Millisecond)
}

// EnsureWebhook records the create-or-repair calls the pass makes for repos
// that have no hook of ours yet.
func (f *fakeUpgradeSource) EnsureWebhook(_ context.Context, owner, name, targetURL, _ string) error {
	now := f.inflight.Add(1)
	defer f.inflight.Add(-1)
	for {
		peak := f.peak.Load()
		if now <= peak || f.peak.CompareAndSwap(peak, now) {
			break
		}
	}
	time.Sleep(f.ensureHold)

	f.mu.Lock()
	defer f.mu.Unlock()
	key := owner + "/" + name
	f.ensured = append(f.ensured, key)
	if f.urls == nil {
		f.urls = map[string]string{}
	}
	f.urls[key] = targetURL

	return f.ensureResults[key]
}

func (f *fakeUpgradeSource) ensuredRepos() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.ensured...)
}

func hookless(forge dashboard.Forge, canManage bool, names ...string) []dashboard.Repo {
	repos := make([]dashboard.Repo, 0, len(names))
	for _, n := range names {
		repos = append(repos, dashboard.Repo{Forge: forge, FullName: n, CanManageWebhooks: canManage})
	}

	return repos
}

func TestWebhookProvision_RepoWithoutHookTheTokenCanAdminister_GetsOneAtTheOwnTargetURL(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Equal(t, []string{"me/bare"}, src.ensuredRepos())
	assert.Equal(t, "https://dash.example/api/webhooks/github/tok", src.urls["me/bare"])
}

func TestWebhookProvision_RepoTheTokenCannotAdminister_IsLeftAlone(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true}, hookless(dashboard.ForgeForgejo, false, "me/locked")...)

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Empty(t, src.ensuredRepos())
}

func TestWebhookProvision_RepoThatAlreadyHasOurHook_IsNotCreatedAgain(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, covered(dashboard.ForgeGitHub, "me/a")...)
	src.result.Repos[0].CanManageWebhooks = true

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Empty(t, src.ensuredRepos())
}

func TestWebhookProvision_OriginAForgeCannotReach_CreatesNothing(t *testing.T) {
	t.Parallel()

	for _, origin := range []string{"http://localhost:8080", "https://192.168.1.20", "http://dash.example", "https://dash.local"} {
		t.Run(origin, func(t *testing.T) {
			t.Parallel()
			src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
			agg := dashboard.NewAggregator([]dashboard.Source{src})
			agg.EnableWebhookUpgrade(t.Context(), fakeCreds{}, origin, dashboard.NewWebhookUpgrades(0))

			refreshAndWait(t, agg)

			assert.Empty(t, src.ensuredRepos())
		})
	}
}

// syncBuffer is a log sink the pass's goroutines can write to while a test reads.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}

// captureLogs swaps the default logger for one that writes to the returned
// buffer. Tests that call it are not parallel: the default logger is global.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return buf
}

func badOriginAggregator(t *testing.T, srcs ...dashboard.Source) *dashboard.Aggregator {
	t.Helper()
	agg := dashboard.NewAggregator(srcs)
	agg.EnableWebhookUpgrade(t.Context(), fakeCreds{}, "http://dash.example", dashboard.NewWebhookUpgrades(0))

	return agg
}

func TestWebhookProvision_UnreachableOrigin_IsLoggedOnceWhileTheProblemStaysTheSame(t *testing.T) {
	logs := captureLogs(t)
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	agg := badOriginAggregator(t, src)

	refreshAndWait(t, agg)
	refreshAndWait(t, agg)
	refreshAndWait(t, agg)

	assert.Equal(t, 1, strings.Count(logs.String(), "not creating hooks"))
}

func TestWebhookProvision_UnreachableOrigin_WithNothingToCreate_LogsNothing(t *testing.T) {
	logs := captureLogs(t)
	repos := append(covered(dashboard.ForgeGitHub, "me/a"), hookless(dashboard.ForgeGitHub, false, "me/locked")...)
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, repos...)

	refreshAndWait(t, badOriginAggregator(t, src))

	assert.NotContains(t, logs.String(), "not creating hooks")
}

func TestWebhookProvision_FailureThatIsNotARefusal_IsNotReportedAsOne(t *testing.T) {
	logs := captureLogs(t)
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	src.ensureResults = map[string]error{"me/bare": errors.New("parse target URL")}

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.NotContains(t, logs.String(), "refused")
	assert.Contains(t, logs.String(), "could not create or repair the hook")
}

func TestWebhookProvision_ShutdownMidPass_LogsNoWarning(t *testing.T) {
	logs := captureLogs(t)
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	src.ensureResults = map[string]error{"me/bare": context.Canceled}

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.NotContains(t, logs.String(), "level=WARN")
}

func TestWebhookOriginProblem(t *testing.T) {
	t.Parallel()

	reachable := []string{
		"https://dash.example.com",
		"https://dash.example.com:8443",
		"https://172.32.0.1",
		"https://100.63.255.255",
		"https://8.8.8.8",
		"https://[2606:4700::1111]",
	}
	for _, origin := range reachable {
		assert.Empty(t, dashboard.WebhookOriginProblem(origin), origin)
	}

	private := []string{
		"https://localhost",
		"https://localhost.",
		"https://LOCALHOST",
		"https://10.0.0.5",
		"https://127.0.0.2",
		"https://169.254.1.1",
		"https://172.16.0.1",
		"https://172.31.255.255",
		"https://192.168.0.1",
		"https://[::1]:8443",
		"https://[fd00::1]",
		"https://[::ffff:127.0.0.1]",
		"https://user@127.0.0.1",
		"https://dash.example@10.0.0.1",
		"https://0.0.0.0",
		"https://0.1.2.3",
		"https://100.64.0.1",
		"https://100.127.255.255",
		"https://127.1",
		"https://0x7f.1",
		"https://0x7f000001",
		"https://2130706433",
		"https://017700000001",
		"https://0177.0.0.1",
		"https://192.168.1",
	}
	for _, origin := range private {
		assert.Contains(t, dashboard.WebhookOriginProblem(origin), "private", origin)
	}

	assert.Contains(t, dashboard.WebhookOriginProblem("http://dash.example.com"), "HTTPS")
	assert.Contains(t, dashboard.WebhookOriginProblem(""), "origin")
}

func TestWebhookProvision_ForgeRateLimited_RetriesOnTheNextRefresh(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	src.ensureResults = map[string]error{"me/bare": &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("rate limited")}}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src)

	refreshAndWait(t, agg)
	src.mu.Lock()
	src.ensureResults = nil
	src.mu.Unlock()
	refreshAndWait(t, agg)

	assert.Equal(t, []string{"me/bare", "me/bare"}, src.ensuredRepos())
}

func TestWebhookProvision_RefusedRepo_IsAskedAgainOnlyAfterTheRetryWait(t *testing.T) {
	t.Parallel()

	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, "me/bare")...)
	src.ensureResults = map[string]error{"me/bare": &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403")}}
	var offset atomic.Int64
	clock := func() time.Time {
		return time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC).Add(time.Duration(offset.Load()))
	}
	agg := upgradingAggregator(t, dashboard.NewWebhookUpgrades(0).WithRetry(time.Hour, clock), src)

	refreshAndWait(t, agg)
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/bare"}, src.ensuredRepos(), "not asked again inside the wait")

	offset.Store(int64(2 * time.Hour))
	refreshAndWait(t, agg)
	assert.Equal(t, []string{"me/bare", "me/bare"}, src.ensuredRepos(), "asked again after it, with no restart")
}

func TestWebhookProvision_ManyRepos_NeverMoreThanFourRequestsAtOnce(t *testing.T) {
	t.Parallel()

	names := make([]string, 0, 12)
	for i := range 12 {
		names = append(names, "me/r"+string(rune('a'+i)))
	}
	src := upgradeSource(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}, hookless(dashboard.ForgeGitHub, true, names...)...)
	src.ensureHold = 20 * time.Millisecond

	refreshAndWait(t, upgradingAggregator(t, dashboard.NewWebhookUpgrades(0), src))

	assert.Len(t, src.ensuredRepos(), 12)
	assert.LessOrEqual(t, src.peak.Load(), int32(4))
}
