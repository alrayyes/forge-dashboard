package dashboard

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
)

// webhookUpgradeConcurrency caps the hooks listings in flight at once, so a
// restart with many covered repos doesn't open them all together.
const webhookUpgradeConcurrency = 4

// DefaultWebhookUpgradeJitter is the longest random pause before each repo's
// hooks listing. It spreads a restart's listings out over a few seconds
// instead of one burst.
const DefaultWebhookUpgradeJitter = 500 * time.Millisecond

// WebhookCredentialSource gives an Aggregator the user's webhook token and
// secret, which an upgrade needs to rebuild the hook's target URL and config.
// settings.Store satisfies it.
type WebhookCredentialSource interface {
	EnsureWebhookCredentials(ctx context.Context) (token, secret string, err error)
}

// WebhookUpgrades remembers, for the life of the process, which repos have had
// their one hooks listing (#1555). Shared by every Aggregator a Service
// builds, so saving credentials, which rebuilds one, doesn't repeat the work.
type WebhookUpgrades struct {
	mu         sync.Mutex
	next       map[string]time.Time
	jitter     time.Duration
	retryAfter time.Duration
	now        func() time.Time
}

// DefaultWebhookRetryAfter is how long the pass leaves a repo alone after
// trying to create or repair its hook, before it tries again without a
// restart (#4018).
const DefaultWebhookRetryAfter = time.Hour

// NewWebhookUpgrades returns an empty record. jitter is the longest random
// pause before each repo's listing; zero turns it off.
func NewWebhookUpgrades(jitter time.Duration) *WebhookUpgrades {
	return &WebhookUpgrades{
		next:       make(map[string]time.Time),
		jitter:     jitter,
		retryAfter: DefaultWebhookRetryAfter,
		now:        time.Now,
	}
}

// WithRetry sets how long a repo is left alone after the pass tried to create
// its hook, and the clock that wait is measured on. It returns w.
func (w *WebhookUpgrades) WithRetry(after time.Duration, now func() time.Time) *WebhookUpgrades {
	w.retryAfter, w.now = after, now

	return w
}

// claimRetry is claim for work that repeats: it succeeds again once the retry
// wait since the last claim has passed.
func (w *WebhookUpgrades) claimRetry(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	if due, ok := w.next[key]; ok && now.Before(due) {
		return false
	}
	w.next[key] = now.Add(w.retryAfter)

	return true
}

func (w *WebhookUpgrades) release(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.next, key)
}

type webhookUpgradeConfig struct {
	ctx     context.Context
	creds   WebhookCredentialSource
	origin  string
	state   *WebhookUpgrades
	running atomic.Bool
	wg      sync.WaitGroup
}

// EnableWebhookUpgrade turns on the once-per-process-start upgrade of this
// user's app-created webhooks (#1555). ctx outlives any one refresh, so a
// refresh a request started doesn't cancel the upgrade when it returns.
func (a *Aggregator) EnableWebhookUpgrade(ctx context.Context, creds WebhookCredentialSource, origin string, state *WebhookUpgrades) {
	a.webhookUpgrade = &webhookUpgradeConfig{ctx: ctx, creds: creds, origin: strings.TrimRight(origin, "/"), state: state}
}

// WaitWebhookUpgrade blocks until an upgrade pass in flight has finished.
func (a *Aggregator) WaitWebhookUpgrade() {
	if cfg := a.webhookUpgrade; cfg != nil {
		cfg.wg.Wait()
	}
}

// startWebhookUpgrade is the post-refresh hook. It hands the pass to its own
// goroutine, so a refresh never waits on hooks listings, and runs one pass at
// a time.
func (a *Aggregator) startWebhookUpgrade(snap Snapshot) {
	cfg := a.webhookUpgrade
	if cfg == nil || !cfg.running.CompareAndSwap(false, true) {
		return
	}
	cfg.wg.Go(func() {
		defer cfg.running.Store(false)
		a.runWebhookUpgrade(cfg, snap)
	})
}

// runWebhookUpgrade visits each forge's repos twice over. A covered repo gets
// its one listing and a repair if the hook is off or out of date (#1555). A
// repo with no hook that the token can administer gets one created (#4018),
// unless the dashboard's public origin is one a forge can't reach. A forge that
// is unreachable or out of REST budget is left for a later refresh. A repo the
// forge refused is asked again only after the retry wait, never in a burst.
func (a *Aggregator) runWebhookUpgrade(cfg *webhookUpgradeConfig, snap Snapshot) {
	healthy := healthyForges(snap)
	originProblem := WebhookOriginProblem(cfg.origin)

	var token, secret string
	for _, src := range a.sources {
		if !healthy[src.Forge()] {
			continue
		}
		if held := a.budgetHold(snap, src.Forge(), apistats.KindHookMaintenance); held {
			continue
		}
		jobs := forgeJobs(src, snap, originProblem)
		if len(jobs) == 0 {
			continue
		}
		if token == "" {
			var err error
			if token, secret, err = cfg.creds.EnsureWebhookCredentials(cfg.ctx); err != nil {
				slog.Warn("webhook upgrade: could not load webhook credentials", "error", err)

				return
			}
		}
		targetURL := cfg.origin + "/api/webhooks/" + string(src.Forge()) + "/" + token
		runJobs(cfg, src.Forge(), jobs, targetURL, secret)
	}
}

// forgeJobs is src's work for one pass: an upgrade for each covered repo, and
// a create for each repo the token can administer that has no hook, unless the
// public origin is one a forge can't reach.
func forgeJobs(src Source, snap Snapshot, originProblem string) []repoJob {
	jobs := upgradeJobs(src, snap)
	if originProblem != "" {
		slog.Info("webhook maintenance: not creating hooks", "forge", src.Forge(), "reason", originProblem)

		return jobs
	}

	return append(jobs, createJobs(src, snap)...)
}

func upgradeJobs(src Source, snap Snapshot) []repoJob {
	upgrader, ok := src.(WebhookUpgrader)
	if !ok {
		return nil
	}
	forge := src.Forge()
	var jobs []repoJob
	for _, fullName := range coveredRepos(snap, forge) {
		jobs = append(jobs, repoJob{
			key: string(forge) + "|" + fullName, fullName: fullName,
			run: func(ctx context.Context, owner, name, targetURL, secret string) error {
				updated, err := upgrader.UpgradeWebhook(ctx, owner, name, targetURL, secret)
				if err != nil {
					return fmt.Errorf("upgrade hook: %w", err)
				}
				if updated {
					slog.Info("webhook upgrade: brought the hook up to date", "forge", forge, "repo", owner+"/"+name)
				}

				return nil
			},
		})
	}

	return jobs
}

func createJobs(src Source, snap Snapshot) []repoJob {
	manager, ok := src.(WebhookManager)
	if !ok {
		return nil
	}
	forge := src.Forge()
	var jobs []repoJob
	for _, fullName := range unhookedRepos(snap, forge) {
		jobs = append(jobs, repoJob{
			key: "create|" + string(forge) + "|" + fullName, fullName: fullName,
			run: func(ctx context.Context, owner, name, targetURL, secret string) error {
				if err := manager.EnsureWebhook(ctx, owner, name, targetURL, secret); err != nil {
					return fmt.Errorf("ensure hook: %w", err)
				}
				slog.Info("webhook maintenance: hook in place", "forge", forge, "repo", owner+"/"+name)

				return nil
			},
		})
	}

	return jobs
}

// healthyForges marks each forge that answered and has REST budget left.
func healthyForges(snap Snapshot) map[Forge]bool {
	healthy := make(map[Forge]bool, len(snap.Forges))
	for _, h := range snap.Forges {
		healthy[h.Forge] = h.Reachable && (h.RateLimitREST == nil || h.RateLimitREST.Remaining > 0)
	}

	return healthy
}

// coveredRepos is the full name of each of forge's repos that has our webhook.
func coveredRepos(snap Snapshot, forge Forge) []string {
	var repos []string
	for _, r := range snap.Repos {
		if r.Forge == forge && r.HasWebhook {
			repos = append(repos, r.FullName)
		}
	}

	return repos
}

// unhookedRepos is the full name of each of forge's repos with no hook of ours
// that the token is allowed to administer. A repo it can't administer is left
// for the manual "Add a webhook" row to explain.
func unhookedRepos(snap Snapshot, forge Forge) []string {
	var repos []string
	for _, r := range snap.Repos {
		if r.Forge == forge && !r.HasWebhook && r.CanManageWebhooks {
			repos = append(repos, r.FullName)
		}
	}

	return repos
}

// repoJob is one repo's hook work, repeated after the retry wait.
type repoJob struct {
	key      string
	fullName string
	run      func(ctx context.Context, owner, name, targetURL, secret string) error
}

func runJobs(cfg *webhookUpgradeConfig, forge Forge, jobs []repoJob, targetURL, secret string) {
	var (
		wg      sync.WaitGroup
		stopped atomic.Bool
		sem     = make(chan struct{}, webhookUpgradeConcurrency)
	)
	for _, job := range jobs {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			if stopped.Load() || cfg.ctx.Err() != nil {
				return
			}
			if !claimAndRun(cfg, forge, job, targetURL, secret, &stopped) {
				// Out of budget or unreachable: not an answer about this
				// repo, so leave it, and the rest of the forge, for later.
				stopped.Store(true)
				cfg.state.release(job.key)
			}
		})
	}
	wg.Wait()
}

// claimAndRun runs job once its key is claimed and the jitter has passed. It
// reports false when the forge could not be asked right now.
func claimAndRun(cfg *webhookUpgradeConfig, forge Forge, job repoJob, targetURL, secret string, stopped *atomic.Bool) bool {
	if !cfg.state.claimRetry(job.key) {
		return true
	}
	if !pauseForJitter(cfg.ctx, cfg.state.jitter) || stopped.Load() {
		cfg.state.release(job.key)

		return true
	}

	return runJob(cfg.ctx, forge, job, targetURL, secret)
}

// runJob reports false when the forge could not be asked right now.
func runJob(ctx context.Context, forge Forge, job repoJob, targetURL, secret string) bool {
	ctx = apistats.WithKind(ctx, apistats.KindHookMaintenance)
	owner, name, ok := strings.Cut(job.fullName, "/")
	if !ok {
		return true
	}
	if err := job.run(ctx, owner, name, targetURL, secret); err != nil {
		if clientErr, isClient := errors.AsType[*ClientError](err); isClient &&
			(clientErr.Kind == ForgeErrorRateLimited || clientErr.Kind == ForgeErrorUnreachable ||
				clientErr.Kind == ForgeErrorUpstream) {
			slog.Info("webhook maintenance: forge not available, trying later", "forge", forge, "repo", job.fullName, "kind", clientErr.Kind)

			return false
		}
		slog.Warn("webhook maintenance: the forge refused the hook", "forge", forge, "repo", job.fullName, "error", err)
	}

	return true
}

// pauseForJitter sleeps a random time up to max, and reports false if ctx
// ended first.
func pauseForJitter(ctx context.Context, maxPause time.Duration) bool {
	if maxPause <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(rand.N(maxPause)) //nolint:gosec // spreading load, not security
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
