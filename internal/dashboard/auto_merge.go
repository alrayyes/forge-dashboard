package dashboard

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AutoMergeStore is what an Aggregator needs to merge the pull requests a
// user armed (the app's own Forgejo auto-merge): the armed set, keyed
// "forge/owner/repo#number", and a way to drop one. settings.Store satisfies
// it. Defined here, in the consuming package.
type AutoMergeStore interface {
	AutoMergeIntents(ctx context.Context, userID []byte) (map[string]struct{}, error)
	CancelAutoMerge(ctx context.Context, userID []byte, forge, repoFullName string, number int) error
}

// autoMergeConfig is nil on an Aggregator that never called EnableAutoMerge.
type autoMergeConfig struct {
	userID []byte
	store  AutoMergeStore

	// attempts remembers the merge tried for each armed pull request, so a
	// refusal is never repeated on every refresh (a refresh runs several
	// times a minute). Guarded by mu.
	mu       sync.Mutex
	attempts map[string]autoMergeAttempt
	// failures and merged feed AutoMergeReport. Guarded by mu.
	failures map[string]AutoMergeFailure
	merged   []AutoMerged
}

// autoMergeAttempt is one merge call. It stands until the pull request
// changes (its UpdatedAt moves) or, for a failure that may clear by itself,
// the wait is up.
type autoMergeAttempt struct {
	updatedAt time.Time
	forever   bool
	until     time.Time
}

// transientAutoMergeWait is how long a rate limit or an unreachable forge
// holds off the next attempt on the same pull request.
const transientAutoMergeWait = 5 * time.Minute

// EnableAutoMerge turns on the hook that runs after every refresh: a Forgejo
// pull request the user armed gets merged, the way a click on Merge would
// merge it, once its checks pass and the forge calls it mergeable. Nothing
// else is ever merged: a pull request the user didn't arm is never touched.
func (a *Aggregator) EnableAutoMerge(userID []byte, store AutoMergeStore) {
	a.autoMerge = &autoMergeConfig{userID: userID, store: store, attempts: make(map[string]autoMergeAttempt), failures: make(map[string]AutoMergeFailure)}
}

// runAutoMerge is the post-refresh hook. A store failure is logged and
// merges nothing.
func (a *Aggregator) runAutoMerge(ctx context.Context, snap Snapshot) {
	cfg := a.autoMerge
	if cfg == nil {
		return
	}

	armed, err := cfg.store.AutoMergeIntents(ctx, cfg.userID)
	if err != nil {
		slog.Warn("auto-merge: could not load armed pull requests", "error", err)

		return
	}
	cfg.prune(armed)
	if len(armed) == 0 {
		return
	}

	open := make(map[string]PullRequest, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		open[dependabotPRKey(pr)] = pr
	}
	for key := range armed {
		pr, listed := open[key]
		if !listed {
			a.dropIfFinished(ctx, snap, key)

			continue
		}
		if pr.Forge != ForgeForgejo || !readyForAutoMerge(pr) {
			continue
		}
		a.autoMergeNow(ctx, pr)
	}
}

// readyForAutoMerge: checks passed, the forge says it can merge, and nothing
// that makes a merge land somewhere else or nowhere. No checks at all isn't a
// pass, since the user armed it to wait for some.
func readyForAutoMerge(pr PullRequest) bool {
	return pr.CI == CISuccess && pr.MergeStatus == MergeMergeable &&
		!pr.Draft && !pr.Empty && pr.StackedOn == nil
}

// autoMergeNow merges pr once per state of the pull request. The attempt is
// recorded before the call, so a concurrent refresh sees it and a failure
// can't loop.
func (a *Aggregator) autoMergeNow(ctx context.Context, pr PullRequest) {
	merger := a.mergerFor(pr.Forge)
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if merger == nil || !ok || !a.autoMerge.begin(pr) {
		return
	}

	slog.Info("auto-merge: merging", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number)
	if err := merger.MergePullRequest(ctx, owner, name, pr.Number); err != nil {
		a.autoMerge.failed(pr, err)
		a.notify(a.Get())
		slog.Warn("auto-merge: merge failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)

		return
	}

	slog.Info("auto-merge: merged", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number)
	if err := a.autoMerge.store.CancelAutoMerge(ctx, a.autoMerge.userID, string(pr.Forge), pr.Repo, pr.Number); err != nil {
		slog.Warn("auto-merge: could not clear the intent", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)
	}
	a.autoMerge.recordMerged(AutoMerged{Forge: pr.Forge, Repo: pr.Repo, Number: pr.Number, At: a.now()}, a.now())
	a.MarkSettled(pr.Forge, pr.Repo, pr.Number)
}

// dropIfFinished removes the intent of an armed pull request the board no
// longer lists, but only once the forge confirms it merged or closed: a
// missing row can also mean a refresh that hasn't caught up.
func (a *Aggregator) dropIfFinished(ctx context.Context, snap Snapshot, key string) {
	forge, repo, number, ok := parseAutoMergeKey(key)
	if !ok || !forgeReachable(snap, forge) {
		return
	}
	owner, name, ok := strings.Cut(repo, "/")
	if !ok {
		return
	}
	var reader PullRequestStateReader
	for _, src := range a.sources {
		if r, can := src.(PullRequestStateReader); can && src.Forge() == forge {
			reader = r
		}
	}
	if reader == nil {
		return
	}

	state, err := reader.ReadPullRequestState(ctx, owner, name, number)
	if err != nil || (!state.Merged && !state.Closed) {
		return
	}
	slog.Info("auto-merge: pull request finished elsewhere, intent removed", "forge", forge, "repo", repo, "number", number)
	if err := a.autoMerge.store.CancelAutoMerge(ctx, a.autoMerge.userID, string(forge), repo, number); err != nil {
		slog.Warn("auto-merge: could not clear the intent", "forge", forge, "repo", repo, "number", number, "error", err)
	}
}

func forgeReachable(snap Snapshot, forge Forge) bool {
	for _, f := range snap.Forges {
		if f.Forge == forge {
			return f.Reachable
		}
	}

	return false
}

// parseAutoMergeKey undoes dependabotPRKey: "forge/owner/repo#number".
func parseAutoMergeKey(key string) (forge Forge, repo string, number int, ok bool) {
	f, rest, found := strings.Cut(key, "/")
	if !found {
		return "", "", 0, false
	}
	repo, num, found := strings.CutLast(rest, "#")
	if !found {
		return "", "", 0, false
	}
	n, err := strconv.Atoi(num)
	if err != nil {
		return "", "", 0, false
	}

	return Forge(f), repo, n, true
}

// mergerFor returns the Source driving forge if it can merge.
func (a *Aggregator) mergerFor(forge Forge) PullRequestMerger {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if m, ok := src.(PullRequestMerger); ok {
			return m
		}
	}

	return nil
}

// begin reports whether pr may be merged now, and records the attempt. False
// while an earlier attempt stands: same pull request state, wait not up.
func (c *autoMergeConfig) begin(pr PullRequest) bool {
	key := dependabotPRKey(pr)

	c.mu.Lock()
	defer c.mu.Unlock()
	if prev, ok := c.attempts[key]; ok && prev.updatedAt.Equal(pr.UpdatedAt) && (prev.forever || time.Now().Before(prev.until)) {
		return false
	}
	c.attempts[key] = autoMergeAttempt{updatedAt: pr.UpdatedAt, forever: true}

	return true
}

// failed records the refusal, and lets a rate limit or an unreachable forge be
// tried again after a wait. Any other refusal stands until the pull request
// changes.
func (c *autoMergeConfig) failed(pr PullRequest, err error) {
	key := dependabotPRKey(pr)
	refusal := mergeRefusal(err)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.failures[key] = AutoMergeFailure{UpdatedAt: pr.UpdatedAt, Refusal: refusal}
	if refusal.Code == ActionRateLimited || isUnreachable(err) {
		c.attempts[key] = autoMergeAttempt{updatedAt: pr.UpdatedAt, until: time.Now().Add(transientAutoMergeWait)}
	}
}

// recordMerged keeps a merge for the report, newest first, dropping the ones
// too old to show.
func (c *autoMergeConfig) recordMerged(m AutoMerged, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	kept := []AutoMerged{m}
	for _, old := range c.merged {
		if now.Sub(old.At) < autoMergedKeep {
			kept = append(kept, old)
		}
	}
	c.merged = kept
	delete(c.failures, dependabotPRKey(PullRequest{Forge: m.Forge, Repo: m.Repo, Number: m.Number}))
}

func isUnreachable(err error) bool {
	clientErr, ok := errors.AsType[*ClientError](err)

	return ok && clientErr.Kind == ForgeErrorUnreachable
}

// prune forgets the attempts of pull requests that are no longer armed, so
// arming one again starts fresh.
func (c *autoMergeConfig) prune(armed map[string]struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key := range c.attempts {
		if _, ok := armed[key]; !ok {
			delete(c.attempts, key)
		}
	}
	for key := range c.failures {
		if _, ok := armed[key]; !ok {
			delete(c.failures, key)
		}
	}
}
