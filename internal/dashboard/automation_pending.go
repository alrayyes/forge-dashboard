package dashboard

import (
	"context"
	"log/slog"
	"time"
)

// automationPending reports whether something the user asked for is waiting on
// the next scheduled refresh, so that resting it while the dashboard is idle
// would delay it. Three things only ever happen after a refresh: a merge, an
// update of a behind branch, and the retry of either.
//
//   - A pull request armed for merge. Its checks may have passed already and
//     its mergeability can change with no webhook (the base moved, a transient
//     "unknown", the wait after a rate limit), and only the next refresh sees it.
//   - A behind pull request with auto-update on, for its repo or by its own
//     choice, that the hook has no standing attempt for: not yet tried, or the
//     wait after a failure is up. A refused one stands for an hour and is no
//     reason to refresh.
//
// What it leaves out rests with the schedule: Dependabot acknowledgement
// lookups and the watch on a rebased Dependabot pull request. Both settle at
// the next use. A read that fails reports false, since a refresh that cannot
// read the user's settings could not act either.
func (a *Aggregator) automationPending(ctx context.Context) bool {
	return a.mergePending(ctx) || a.updatePending(ctx)
}

func (a *Aggregator) mergePending(ctx context.Context) bool {
	cfg := a.autoMerge
	if cfg == nil {
		return false
	}

	armed, err := cfg.store.AutoMergeIntents(ctx)
	if err != nil {
		slog.Warn("auto-merge: could not load armed pull requests", "error", err)

		return false
	}

	return len(armed) > 0
}

func (a *Aggregator) updatePending(ctx context.Context) bool {
	cfg := a.autoUpdate
	if cfg == nil {
		return false
	}

	enabled, err := cfg.lister.AutoUpdateBranchRepos(ctx)
	if err != nil {
		slog.Warn("auto-update-branch: could not load enabled repos", "error", err)

		return false
	}
	overrides, err := cfg.lister.PullRequestAutoUpdates(ctx)
	if err != nil {
		slog.Warn("auto-update-branch: could not load pull request choices", "error", err)
		overrides = nil
	}
	if len(enabled) == 0 && len(overrides) == 0 {
		return false
	}

	for _, pr := range a.Get().PullRequests {
		if !pr.Behind || pr.Draft || !autoUpdateWanted(pr, enabled, overrides) {
			continue
		}
		if a.updateWouldBeTried(pr) {
			return true
		}
	}

	return false
}

// updateWouldBeTried is whether the auto-update hook would act on pr now,
// without acting: a Dependabot pull request is sent one rebase and then left
// alone, anything else waits out its last attempt.
func (a *Aggregator) updateWouldBeTried(pr PullRequest) bool {
	if isDependabotPR(pr) {
		a.autoUpdate.dependabotWatchMu.Lock()
		defer a.autoUpdate.dependabotWatchMu.Unlock()
		_, tried := a.autoUpdate.dependabotAttempted[dependabotPRKey(pr)]

		return !tried
	}

	a.autoUpdate.updateMu.Lock()
	defer a.autoUpdate.updateMu.Unlock()
	prev, ok := a.autoUpdate.updateAttempts[dependabotPRKey(pr)]

	return !ok || !prev.updatedAt.Equal(pr.UpdatedAt) || time.Since(prev.at) >= prev.wait
}
