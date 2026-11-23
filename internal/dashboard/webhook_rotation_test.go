package dashboard_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ledgerCreds is fakeCreds plus the stored record of which secret the hooks
// were last written with.
type ledgerCreds struct {
	fakeCreds

	mu     sync.Mutex
	synced string
	marks  int
}

func (l *ledgerCreds) WebhookSecretSynced(context.Context) (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.synced, nil
}

func (l *ledgerCreds) MarkWebhookSecretSynced(_ context.Context, fp string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.synced = fp
	l.marks++

	return nil
}

func (l *ledgerCreds) current() (string, int) {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.synced, l.marks
}

// rewriteSource also records every RewriteWebhookSecret call.
type rewriteSource struct {
	fakeUpgradeSource

	rewritten []string
	rewriteBy map[string]error
	secrets   []string
}

func (f *rewriteSource) RewriteWebhookSecret(_ context.Context, owner, name, _, secret string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := owner + "/" + name
	f.rewritten = append(f.rewritten, key)
	f.secrets = append(f.secrets, secret)

	return true, f.rewriteBy[key]
}

func (f *rewriteSource) rewrites() []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]string(nil), f.rewritten...)
}

func (f *rewriteSource) setRewriteResults(m map[string]error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rewriteBy = m
}

func rewriteAggregator(t *testing.T, creds dashboard.WebhookCredentialSource, src dashboard.Source) *dashboard.Aggregator {
	t.Helper()
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.EnableWebhookUpgrade(t.Context(), creds, "https://dash.example", dashboard.NewWebhookUpgrades(0))

	return agg
}

func newRewriteSource(names ...string) *rewriteSource {
	src := &rewriteSource{}
	src.result = dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		Repos:  covered(dashboard.ForgeGitHub, names...),
	}

	return src
}

func TestWebhookRotation_ChangedSecret_RewritesEveryCoveredHookWithTheNewSecret(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a", "me/b")
	ledger := &ledgerCreds{synced: "fingerprint-of-the-old-secret"}

	refreshAndWait(t, rewriteAggregator(t, ledger, src))

	assert.ElementsMatch(t, []string{"me/a", "me/b"}, src.rewrites())
	assert.Equal(t, []string{"sekret", "sekret"}, src.secrets)
}

func TestWebhookRotation_AfterEveryRewrite_TheNewSecretIsRecordedOnce(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a")
	ledger := &ledgerCreds{synced: "old"}

	refreshAndWait(t, rewriteAggregator(t, ledger, src))
	fp, marks := ledger.current()

	assert.NotEqual(t, "old", fp)
	assert.Equal(t, 1, marks)
}

func TestWebhookRotation_UnchangedSecret_MakesNoRewriteAndNoWrite(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a")
	ledger := &ledgerCreds{}
	refreshAndWait(t, rewriteAggregator(t, ledger, src)) // first sight: the baseline is recorded
	_, baseline := ledger.current()

	refreshAndWait(t, rewriteAggregator(t, ledger, src))
	_, marks := ledger.current()

	assert.Empty(t, src.rewrites())
	assert.Equal(t, baseline, marks, "the ledger is not written again")
}

func TestWebhookRotation_FirstSight_RecordsTheSecretWithoutRewriting(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a")
	ledger := &ledgerCreds{}

	refreshAndWait(t, rewriteAggregator(t, ledger, src))
	fp, _ := ledger.current()

	assert.Empty(t, src.rewrites())
	assert.NotEmpty(t, fp)
}

func TestWebhookRotation_RateLimitedForge_RetriesLaterAndDoesNotRecordTheSecret(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a")
	src.setRewriteResults(map[string]error{"me/a": &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("slow down")}})
	ledger := &ledgerCreds{synced: "old"}
	agg := rewriteAggregator(t, ledger, src)

	refreshAndWait(t, agg)
	fp, _ := ledger.current()
	require.Equal(t, "old", fp, "a repo still on the old secret keeps the rotation open")
	assert.Len(t, agg.Get().Repos, 1, "the refresh itself succeeded")

	src.setRewriteResults(nil)
	refreshAndWait(t, agg)
	fp, _ = ledger.current()

	assert.Equal(t, []string{"me/a", "me/a"}, src.rewrites())
	assert.NotEqual(t, "old", fp)
}

func TestWebhookRotation_RewrittenRepo_IsNotRewrittenAgainWhileTheOtherRetries(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a", "me/b")
	src.setRewriteResults(map[string]error{"me/b": &dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: errors.New("down")}})
	ledger := &ledgerCreds{synced: "old"}
	agg := rewriteAggregator(t, ledger, src)
	refreshAndWait(t, agg)

	src.setRewriteResults(nil)
	refreshAndWait(t, agg)

	count := map[string]int{}
	for _, k := range src.rewrites() {
		count[k]++
	}
	assert.Equal(t, 1, count["me/a"])
}

func TestWebhookRotation_RefusedRepo_DoesNotKeepTheRotationOpenForever(t *testing.T) {
	t.Parallel()

	src := newRewriteSource("me/a")
	src.setRewriteResults(map[string]error{"me/a": &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("403")}})
	ledger := &ledgerCreds{synced: "old"}

	refreshAndWait(t, rewriteAggregator(t, ledger, src))
	fp, _ := ledger.current()

	assert.NotEqual(t, "old", fp)
}
