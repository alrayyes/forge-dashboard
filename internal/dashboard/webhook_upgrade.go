package dashboard

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strings"
	"sync"
	"sync/atomic"
	"time"
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
	EnsureWebhookCredentials(ctx context.Context, userID []byte) (token, secret string, err error)
}

// WebhookUpgrades remembers, for the life of the process, which repos have had
// their one hooks listing (#1555). Shared by every Aggregator a Manager
// builds, so saving credentials, which rebuilds one, doesn't repeat the work.
type WebhookUpgrades struct {
	mu     sync.Mutex
	tried  map[string]struct{}
	jitter time.Duration
}

// NewWebhookUpgrades returns an empty record. jitter is the longest random
// pause before each repo's listing; zero turns it off.
func NewWebhookUpgrades(jitter time.Duration) *WebhookUpgrades {
	return &WebhookUpgrades{tried: make(map[string]struct{}), jitter: jitter}
}

func (w *WebhookUpgrades) claim(key string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if _, ok := w.tried[key]; ok {
		return false
	}
	w.tried[key] = struct{}{}

	return true
}

func (w *WebhookUpgrades) release(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	delete(w.tried, key)
}

type webhookUpgradeConfig struct {
	ctx     context.Context
	userID  []byte
	creds   WebhookCredentialSource
	origin  string
	state   *WebhookUpgrades
	running atomic.Bool
	wg      sync.WaitGroup
}

// EnableWebhookUpgrade turns on the once-per-process-start upgrade of this
// user's app-created webhooks (#1555). ctx outlives any one refresh, so a
// refresh a request started doesn't cancel the upgrade when it returns.
func (a *Aggregator) EnableWebhookUpgrade(ctx context.Context, userID []byte, creds WebhookCredentialSource, origin string, state *WebhookUpgrades) {
	a.webhookUpgrade = &webhookUpgradeConfig{ctx: ctx, userID: userID, creds: creds, origin: strings.TrimRight(origin, "/"), state: state}
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

// runWebhookUpgrade visits each forge's covered repos that haven't had their
// listing yet. A forge that is unreachable or out of REST budget is left for
// a later refresh. A repo the forge refused (no admin right on its hooks) is
// not asked again before the next start.
func (a *Aggregator) runWebhookUpgrade(cfg *webhookUpgradeConfig, snap Snapshot) {
	healthy := healthyForges(snap)

	var token, secret string
	for _, src := range a.sources {
		upgrader, ok := src.(WebhookUpgrader)
		if !ok || !healthy[src.Forge()] {
			continue
		}
		repos := coveredRepos(snap, src.Forge())
		if len(repos) == 0 {
			continue
		}
		if token == "" {
			var err error
			if token, secret, err = cfg.creds.EnsureWebhookCredentials(cfg.ctx, cfg.userID); err != nil {
				slog.Warn("webhook upgrade: could not load webhook credentials", "error", err)

				return
			}
		}
		targetURL := cfg.origin + "/api/webhooks/" + string(src.Forge()) + "/" + token
		upgradeForge(cfg, src.Forge(), upgrader, repos, targetURL, secret)
	}
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

func upgradeForge(cfg *webhookUpgradeConfig, forge Forge, upgrader WebhookUpgrader, repos []string, targetURL, secret string) {
	var (
		wg      sync.WaitGroup
		stopped atomic.Bool
		sem     = make(chan struct{}, webhookUpgradeConcurrency)
	)
	for _, fullName := range repos {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			if stopped.Load() || cfg.ctx.Err() != nil {
				return
			}
			key := string(cfg.userID) + "|" + string(forge) + "|" + fullName
			if !cfg.state.claim(key) {
				return
			}
			if !pauseForJitter(cfg.ctx, cfg.state.jitter) || stopped.Load() {
				cfg.state.release(key)

				return
			}
			if !upgradeRepo(cfg.ctx, forge, upgrader, fullName, targetURL, secret) {
				// Out of budget or unreachable: not an answer about this
				// repo, so leave it, and the rest of the forge, for later.
				stopped.Store(true)
				cfg.state.release(key)
			}
		})
	}
	wg.Wait()
}

// upgradeRepo reports false when the forge could not be asked right now.
func upgradeRepo(ctx context.Context, forge Forge, upgrader WebhookUpgrader, fullName, targetURL, secret string) bool {
	owner, name, ok := strings.Cut(fullName, "/")
	if !ok {
		return true
	}
	updated, err := upgrader.UpgradeWebhook(ctx, owner, name, targetURL, secret)
	if err != nil {
		if clientErr, isClient := errors.AsType[*ClientError](err); isClient &&
			(clientErr.Kind == ForgeErrorRateLimited || clientErr.Kind == ForgeErrorUnreachable) {
			slog.Info("webhook upgrade: forge not available, trying later", "forge", forge, "repo", fullName, "kind", clientErr.Kind)

			return false
		}
		slog.Warn("webhook upgrade: cannot upgrade, not trying again until restart", "forge", forge, "repo", fullName, "error", err)

		return true
	}
	if updated {
		slog.Info("webhook upgrade: brought the hook's events up to date", "forge", forge, "repo", fullName)
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
