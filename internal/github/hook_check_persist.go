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

		c.hooksMu.Lock()
		defer c.hooksMu.Unlock()
		for _, check := range checks {
			if check.Has {
				if c.ownHookEvents == nil {
					c.ownHookEvents = make(map[string][]string)
				}
				c.ownHookEvents[check.Repo] = slices.Clone(check.Events)
			}
			if c.refusedRepo == nil {
				c.refusedRepo = map[string]bool{}
			}
			c.refusedRepo[check.Repo] = check.Refused
			if c.hookLastSaved == nil {
				c.hookLastSaved = map[string]dashboard.HookCheck{}
			}
			c.hookLastSaved[check.Repo] = check
		}
	})
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
	same := known && last.Has == check.Has && last.Refused == check.Refused && slices.Equal(last.Events, check.Events)
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
