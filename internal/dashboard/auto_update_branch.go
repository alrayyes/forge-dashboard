package dashboard

import (
	"context"
	"log/slog"
	"strings"
)

// AutoUpdateBranchLister reports what an Aggregator needs to decide
// which behind pull requests to auto-update for userID (#365): the set
// of repos enabled for it, and whether bot-managed pull requests are
// included — both queried fresh on every refresh, from the same source,
// so they can never drift out of sync with each other. Defined here in
// the consuming package per go.md, rather than importing internal/settings'
// concrete *Store directly. settings.Store satisfies this today.
type AutoUpdateBranchLister interface {
	AutoUpdateBranchRepos(ctx context.Context, userID []byte) (map[string]struct{}, error)
	AllowsBotPRUpdates(ctx context.Context, userID []byte) (bool, error)
}

// autoUpdateBranchConfig holds what an Aggregator needs to run the
// post-refresh auto-update-branch hook — nil on an Aggregator that never
// called EnableAutoUpdateBranch, which is every one before #365 and
// every one Manager builds with no AutoUpdateBranchLister configured.
type autoUpdateBranchConfig struct {
	userID []byte
	lister AutoUpdateBranchLister
}

// EnableAutoUpdateBranch turns on the hook that runs after every
// completed refresh: any pull request the snapshot reports Behind, on a
// repo lister currently reports enabled for userID, gets UpdateBranch
// called on it the same way a manual click would — skipped for a
// bot-managed pull request unless lister currently allows that too, the
// same restraint the manual button already applies. Both are queried
// fresh on every refresh, since this Aggregator's own dedicated
// enable/disable endpoints (and a bot-PR-updates toggle) don't trigger a
// rebuild the way most other settings changes do.
func (a *Aggregator) EnableAutoUpdateBranch(userID []byte, lister AutoUpdateBranchLister) {
	a.autoUpdate = &autoUpdateBranchConfig{userID: userID, lister: lister}
}

// runAutoUpdateBranch is the post-refresh hook itself — a no-op if
// EnableAutoUpdateBranch was never called. A lister failure is logged
// and otherwise ignored: the snapshot it has nothing to do with must
// still stand, the same resilience refreshOnce already gives one
// source's own failure.
func (a *Aggregator) runAutoUpdateBranch(ctx context.Context, snap Snapshot) {
	if a.autoUpdate == nil {
		return
	}

	enabled, err := a.autoUpdate.lister.AutoUpdateBranchRepos(ctx, a.autoUpdate.userID)
	if err != nil {
		slog.Warn("auto-update-branch: could not load enabled repos", "error", err)

		return
	}
	if len(enabled) == 0 {
		return
	}

	allowBotPRUpdates, err := a.autoUpdate.lister.AllowsBotPRUpdates(ctx, a.autoUpdate.userID)
	if err != nil {
		slog.Warn("auto-update-branch: could not load bot-pr-updates setting", "error", err)

		return
	}

	for _, pr := range snap.PullRequests {
		if !pr.Behind {
			continue
		}
		if _, ok := enabled[string(pr.Forge)+"/"+pr.Repo]; !ok {
			continue
		}
		if IsBotManagedPR(pr) && !allowBotPRUpdates {
			continue
		}

		updater := a.branchUpdaterFor(pr.Forge)
		if updater == nil {
			continue
		}
		owner, name, ok := strings.Cut(pr.Repo, "/")
		if !ok {
			continue
		}
		if _, err := updater.UpdateBranch(ctx, owner, name, pr.Number); err != nil {
			slog.Warn("auto-update-branch failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)
		}
	}
}

// branchUpdaterFor returns the configured Source driving forge, if it
// supports BranchUpdater — nil for no matching Source, or one that
// doesn't, the same "just skip it" shape RefreshRepo's own lookup uses.
func (a *Aggregator) branchUpdaterFor(forge Forge) BranchUpdater {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if u, ok := src.(BranchUpdater); ok {
			return u
		}

		return nil
	}

	return nil
}
