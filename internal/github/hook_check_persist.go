package github

import (
	"context"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// processHookChecks is the store a Client uses when it has none of its own.
var processHookChecks struct {
	mu    sync.RWMutex
	store dashboard.HookCheckStore
}

// SetHookCheckStore keeps the webhook check results of every Client that has
// no store of its own in store, so a restart doesn't start with no idea which
// repos have the app's hook. Call it once at start, before any Client carries
// traffic.
func SetHookCheckStore(store dashboard.HookCheckStore) {
	processHookChecks.mu.Lock()
	defer processHookChecks.mu.Unlock()
	processHookChecks.store = store
}

// SetHookCheckStore keeps this client's webhook check results in store. Call
// it after SetStats, since rows are keyed by the credential label.
func (c *Client) SetHookCheckStore(store dashboard.HookCheckStore) {
	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()
	c.hookStore = store
}

func (c *Client) hookChecks() dashboard.HookCheckStore {
	c.hooksMu.Lock()
	store := c.hookStore
	c.hooksMu.Unlock()
	if store != nil {
		return store
	}
	processHookChecks.mu.RLock()
	defer processHookChecks.mu.RUnlock()

	return processHookChecks.store
}

// restoreHookChecks loads what the last run learned, once, before the first
// answer is used. An unreadable store leaves the client starting empty.
func (c *Client) restoreHookChecks() {
	c.hookRestore.Do(func() {
		store := c.hookChecks()
		if store == nil {
			return
		}
		checks, err := store.LoadHookChecks(context.Background(), dashboard.ForgeGitHub, c.statsCredential)
		if err != nil {
			slog.Warn("saved webhook checks unreadable, starting empty", "error", err)

			return
		}

		c.adoptHookChecks(checks)
	})
}

// adoptHookChecks makes the saved answers the client's current knowledge.
func (c *Client) adoptHookChecks(checks []dashboard.HookCheck) {
	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()

	if c.ownHookEvents == nil {
		c.ownHookEvents = make(map[string][]string)
	}
	if c.refusedRepo == nil {
		c.refusedRepo = map[string]bool{}
	}
	if c.hookLastSaved == nil {
		c.hookLastSaved = map[string]dashboard.HookCheck{}
	}
	for _, check := range checks {
		if age := time.Since(check.CheckedAt); age > dashboard.HookCheckFreshness || age < -time.Minute {
			// Too old to believe, or stamped in the future: leave the repo
			// unknown until the next real check answers.
			continue
		}
		if check.Has {
			c.ownHookEvents[check.Repo] = slices.Clone(check.Events)
		}
		c.refusedRepo[check.Repo] = check.Refused
		c.hookLastSaved[check.Repo] = check
	}
}

// saveHookCheck stores a real answer about fullName when it differs from the
// last one stored, so a steady state costs no writes.
func (c *Client) saveHookCheck(fullName string, probe hookProbe) {
	store := c.hookChecks()
	if store == nil {
		return
	}
	check := dashboard.HookCheck{
		Repo:      fullName,
		Has:       probe.has,
		Events:    slices.Clone(probe.events),
		Refused:   probe.refused,
		CheckedAt: time.Now().UTC(),
	}

	c.hooksMu.Lock()
	last, known := c.hookLastSaved[fullName]
	same := known && last.Has == check.Has && last.Refused == check.Refused && slices.Equal(last.Events, check.Events) &&
		check.CheckedAt.Sub(last.CheckedAt) < dashboard.HookCheckFreshness/2
	c.hooksMu.Unlock()
	if same {
		return
	}

	if err := store.SaveHookCheck(context.Background(), dashboard.ForgeGitHub, c.statsCredential, check); err != nil {
		slog.Warn("could not save the webhook check", "repo", fullName, "error", err)

		return
	}
	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()
	if c.hookLastSaved == nil {
		c.hookLastSaved = map[string]dashboard.HookCheck{}
	}
	c.hookLastSaved[fullName] = check
}

// hookPruneEvery is how often saved checks for repos the credential no longer
// lists are dropped. A repo that is merely archived, a fork or read-only is
// still listed, so a permission change doesn't cost it its rows.
const hookPruneEvery = 12 * time.Hour

// SetHookPruneInterval changes how often saved checks are pruned. Tests use it;
// the default is twelve hours.
func (c *Client) SetHookPruneInterval(d time.Duration) {
	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()
	c.hookPruneInterval = d
}

// pruneHookChecks forgets the saved checks and deliveries of repos the
// credential no longer lists at all, so they don't pile up for the life of the
// database, and the client's own memory of them with it (otherwise a repo that
// returns unchanged would look already saved). It runs at most once per
// interval. Only the GitHub client calls it; other forges keep their rows.
func (c *Client) pruneHookChecks(ctx context.Context, repos []graphqlRepo) {
	store := c.hookChecks()
	if store == nil || len(repos) == 0 {
		return
	}
	c.hooksMu.Lock()
	every := c.hookPruneInterval
	if every == 0 {
		every = hookPruneEvery
	}
	if !c.hookPrunedAt.IsZero() && time.Since(c.hookPrunedAt) < every {
		c.hooksMu.Unlock()

		return
	}
	c.hookPrunedAt = time.Now()
	c.hooksMu.Unlock()

	names := make([]string, 0, len(repos))
	for _, r := range repos {
		names = append(names, r.Owner.Login+"/"+r.Name)
	}
	if err := store.PruneUntracked(ctx, dashboard.ForgeGitHub, c.statsCredential, names); err != nil {
		slog.Warn("could not prune saved webhook checks", "error", err)

		return
	}

	c.hooksMu.Lock()
	defer c.hooksMu.Unlock()
	for repo := range c.hookLastSaved {
		if !slices.Contains(names, repo) {
			delete(c.hookLastSaved, repo)
			delete(c.ownHookEvents, repo)
		}
	}
}
