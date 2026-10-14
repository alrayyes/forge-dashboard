package dashboard

import (
	"context"
	"log/slog"
	"strings"
	"time"
)

// cancelEmptyAutoMerges takes an armed auto-merge back off a pull request that
// has gone empty (#1375): its branch landed on the base some other way, so
// there is nothing left for auto-merge to wait for, and left on it would try to
// merge an empty commit. GitHub's own auto-merge is turned off with
// disablePullRequestAutoMerge; Forgejo's is this app's intent, which is dropped.
// The reason is kept for the row. A pull request that is not armed, or is not
// empty, is never touched.
func (a *Aggregator) cancelEmptyAutoMerges(ctx context.Context, snap Snapshot) {
	cfg := a.autoMerge
	cfg.forgetGone(snap)

	var intents map[string]struct{}
	intentsFailed := false
	for _, pr := range snap.PullRequests {
		if !pr.Empty {
			continue
		}
		key := dependabotPRKey(pr)
		if pr.Forge == ForgeForgejo && intents == nil && !intentsFailed {
			loaded, err := cfg.store.AutoMergeIntents(ctx, cfg.userID)
			if err != nil {
				// A Forgejo pull request can't be told to be armed without the
				// set; GitHub's own state is on the pull request, so go on.
				slog.Warn("auto-merge: could not load armed pull requests", "error", err)
				intentsFailed = true
			}
			intents = loaded
		}
		if intentsFailed && pr.Forge == ForgeForgejo {
			continue
		}
		if !armedOn(pr, key, intents) || !cfg.beginCancel(pr) {
			continue
		}
		a.cancelAutoMerge(ctx, pr, key)
	}
}

// armedOn reports whether auto-merge is on for pr: GitHub's own, read from the
// pull request, or this app's Forgejo intent.
func armedOn(pr PullRequest, key string, intents map[string]struct{}) bool {
	switch pr.Forge {
	case ForgeGitHub:
		return pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled
	case ForgeForgejo:
		_, armed := intents[key]

		return armed
	}

	return false
}

func (a *Aggregator) cancelAutoMerge(ctx context.Context, pr PullRequest, key string) {
	cfg := a.autoMerge
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return
	}

	switch pr.Forge {
	case ForgeGitHub:
		var disabler PullRequestAutoMergeDisabler
		for _, src := range a.sources {
			if d, can := src.(PullRequestAutoMergeDisabler); can && src.Forge() == ForgeGitHub {
				disabler = d
			}
		}
		if disabler == nil {
			return
		}
		if err := disabler.DisableAutoMerge(ctx, owner, name, pr.Number); err != nil {
			cfg.cancelFailed(pr)
			slog.Warn("auto-merge: could not cancel on an empty pull request", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)

			return
		}
	default:
		if err := cfg.store.CancelAutoMerge(ctx, cfg.userID, string(pr.Forge), pr.Repo, pr.Number); err != nil {
			cfg.cancelFailed(pr)
			slog.Warn("auto-merge: could not drop the intent on an empty pull request", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)

			return
		}
	}

	slog.Info("auto-merge: cancelled, the pull request is empty", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number)
	cfg.recordCancelled(key, AutoMergeCancelled{
		At: a.now(),
		Refusal: ActionRefusal{
			Code:    ActionAlreadyUpToDate,
			Message: "Auto-merge was cancelled: there is nothing left to merge.",
		},
	})
	a.notify(a.Get())
}

// forgetGone drops what is kept for pull requests the snapshot no longer lists
// (merged, closed), and the cancellations too old to show, so neither map grows
// for ever. A pull request that is still listed keeps its entry, which is what
// stops a stale snapshot from cancelling twice.
func (c *autoMergeConfig) forgetGone(snap Snapshot) {
	listed := make(map[string]struct{}, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		listed[dependabotPRKey(pr)] = struct{}{}
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.cancelAttempts {
		if _, ok := listed[key]; !ok {
			delete(c.cancelAttempts, key)
		}
	}
	for key, cancelled := range c.cancelled {
		if _, ok := listed[key]; !ok && time.Since(cancelled.At) >= autoMergedKeep {
			delete(c.cancelled, key)
		}
	}
}

// beginCancel reports whether the cancel may be tried now, and records the
// attempt. False while an earlier attempt on the same state of the pull
// request stands.
func (c *autoMergeConfig) beginCancel(pr PullRequest) bool {
	key := dependabotPRKey(pr)

	c.mu.Lock()
	defer c.mu.Unlock()
	if prev, ok := c.cancelAttempts[key]; ok && prev.updatedAt.Equal(pr.UpdatedAt) && (prev.forever || time.Now().Before(prev.until)) {
		return false
	}
	c.cancelAttempts[key] = autoMergeAttempt{updatedAt: pr.UpdatedAt, forever: true}

	return true
}

// cancelFailed lets the cancel be tried again after a wait.
func (c *autoMergeConfig) cancelFailed(pr PullRequest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancelAttempts[dependabotPRKey(pr)] = autoMergeAttempt{updatedAt: pr.UpdatedAt, until: time.Now().Add(transientAutoMergeWait)}
}

func (c *autoMergeConfig) recordCancelled(key string, cancelled AutoMergeCancelled) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cancelled[key] = cancelled
	delete(c.failures, key)
}
