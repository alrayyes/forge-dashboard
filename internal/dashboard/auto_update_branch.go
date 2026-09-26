package dashboard

import (
	"context"
	"log/slog"
	"strconv"
	"strings"
	"sync"
)

// AutoUpdateBranchLister reports what an Aggregator needs to decide
// which behind pull requests to auto-update for userID (#365): the set
// of repos enabled for it. Defined here in the consuming package per
// go.md, rather than importing internal/settings' concrete *Store
// directly. settings.Store satisfies this today.
type AutoUpdateBranchLister interface {
	AutoUpdateBranchRepos(ctx context.Context, userID []byte) (map[string]struct{}, error)
	// RenovateRebaseLabel reports userID's own configured Renovate rebase
	// label (Credentials.RenovateRebaseLabelOrDefault) — what a behind
	// Renovate pull request gets labeled with instead of the generic
	// UpdateBranch call (#541), mirroring the manual Renovate: Rebase
	// button.
	RenovateRebaseLabel(ctx context.Context, userID []byte) (string, error)
}

// autoUpdateBranchConfig holds what an Aggregator needs to run the
// post-refresh auto-update-branch hook — nil on an Aggregator that never
// called EnableAutoUpdateBranch, which is every one before #365 and
// every one Manager builds with no AutoUpdateBranchLister configured.
type autoUpdateBranchConfig struct {
	userID []byte
	lister AutoUpdateBranchLister

	// dependabotWatch holds the key (see dependabotPRKey) of every open
	// Dependabot pull request this hook has posted DependabotRebaseComment
	// on and is still waiting to see the outcome of — cleared once its CI
	// resolves (success: the rebase held; failure: DependabotRecreateComment
	// gets posted) or it drops out of the snapshot entirely (closed/merged).
	// In-memory only: losing it on a process restart just means that one
	// pull request doesn't get auto-recreated, which the manual Dependabot:
	// Recreate button still covers — not worth a persisted table for (#540).
	dependabotWatchMu sync.Mutex
	dependabotWatch   map[string]struct{}
}

// EnableAutoUpdateBranch turns on the hook that runs after every
// completed refresh: any pull request the snapshot reports Behind, on a
// repo lister currently reports enabled for userID, gets brought up to
// date the same way a manual click would — except a release-please pull
// request, which is always skipped (release-please regenerates its own
// branch and changelog together on every push to the base branch, so a
// generic branch update is a genuine risk of fighting its own next run,
// and it has no dedicated rebase/label action the way Dependabot and
// Renovate do). A Dependabot pull request gets DependabotRebaseComment
// instead of the generic UpdateBranch, mirroring the manual Dependabot:
// Rebase button, with a follow-up DependabotRecreateComment if that
// rebase leaves its CI failing (#540). A Renovate pull request instead
// gets lister's own configured rebase label added (AddLabel), mirroring
// the manual Renovate: Rebase button — Renovate has no recreate
// equivalent, so no watch state to track (#541). Both settings are
// queried fresh on every refresh, since this Aggregator's own dedicated
// enable/disable endpoints don't trigger a rebuild the way most other
// settings changes do.
func (a *Aggregator) EnableAutoUpdateBranch(userID []byte, lister AutoUpdateBranchLister) {
	a.autoUpdate = &autoUpdateBranchConfig{userID: userID, lister: lister, dependabotWatch: make(map[string]struct{})}
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

	a.reconcileDependabotRebaseWatch(ctx, snap)

	enabled, err := a.autoUpdate.lister.AutoUpdateBranchRepos(ctx, a.autoUpdate.userID)
	if err != nil {
		slog.Warn("auto-update-branch: could not load enabled repos", "error", err)

		return
	}
	if len(enabled) == 0 {
		return
	}

	renovateLabel, err := a.autoUpdate.lister.RenovateRebaseLabel(ctx, a.autoUpdate.userID)
	if err != nil {
		slog.Warn("auto-update-branch: could not load renovate rebase label", "error", err)

		return
	}

	for _, pr := range snap.PullRequests {
		if !pr.Behind {
			continue
		}
		if _, ok := enabled[string(pr.Forge)+"/"+pr.Repo]; !ok {
			continue
		}
		if isReleasePleasePR(pr) {
			continue
		}

		a.updateBehindPR(ctx, pr, renovateLabel)
	}
}

// updateBehindPR brings pr up to date the way its author calls for: a
// Dependabot pull request gets DependabotRebaseComment, a Renovate one
// gets renovateLabel added, and anything else gets the generic
// UpdateBranch — runAutoUpdateBranch's own per-PR routing, split out only
// to keep that loop's own branching under gocyclo's threshold.
func (a *Aggregator) updateBehindPR(ctx context.Context, pr PullRequest, renovateLabel string) {
	if isDependabotPR(pr) {
		a.rebaseDependabotPR(ctx, pr)

		return
	}

	if isRenovatePR(pr) {
		a.labelRenovatePR(ctx, pr, renovateLabel)

		return
	}

	updater := a.branchUpdaterFor(pr.Forge)
	if updater == nil {
		return
	}
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return
	}
	if _, err := updater.UpdateBranch(ctx, owner, name, pr.Number); err != nil {
		slog.Warn("auto-update-branch failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)
	}
}

// dependabotPRKey identifies pr for dependabotWatch — forge and repo alone
// aren't enough since a repo can have more than one open Dependabot PR.
func dependabotPRKey(pr PullRequest) string {
	return string(pr.Forge) + "/" + pr.Repo + "#" + strconv.Itoa(pr.Number)
}

// rebaseDependabotPR posts DependabotRebaseComment on pr and, only once that
// succeeds, starts watching it for reconcileDependabotRebaseWatch to follow
// up on. A comment failure is logged the same way UpdateBranch's own failure
// already is; the PR simply isn't watched, so a later refresh just retries
// the rebase rather than jumping straight to a recreate it never earned.
func (a *Aggregator) rebaseDependabotPR(ctx context.Context, pr PullRequest) {
	commenter := a.commenterFor(pr.Forge)
	if commenter == nil {
		return
	}
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return
	}
	if err := commenter.CommentPullRequest(ctx, owner, name, pr.Number, DependabotRebaseComment); err != nil {
		slog.Warn("auto-update-branch: dependabot rebase failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)

		return
	}

	a.autoUpdate.dependabotWatchMu.Lock()
	a.autoUpdate.dependabotWatch[dependabotPRKey(pr)] = struct{}{}
	a.autoUpdate.dependabotWatchMu.Unlock()
}

// reconcileDependabotRebaseWatch resolves every pull request rebaseDependabotPR
// is currently watching, against snap's own view of it: CIFailure posts
// DependabotRecreateComment once and stops watching it, CISuccess just stops
// watching it (the rebase held, nothing further to do), and CIPending/CINone
// leaves it watched for the next refresh to check again. A pull request that
// dropped out of snap entirely (closed or merged since the rebase) also stops
// being watched, so a resolved PR doesn't sit in the map for the rest of the
// process's life. Runs unconditionally — ahead of the enabled-repos check —
// since a setting flipped off after the rebase already went out shouldn't
// leave a since-failed PR un-recreated.
func (a *Aggregator) reconcileDependabotRebaseWatch(ctx context.Context, snap Snapshot) {
	a.autoUpdate.dependabotWatchMu.Lock()
	if len(a.autoUpdate.dependabotWatch) == 0 {
		a.autoUpdate.dependabotWatchMu.Unlock()

		return
	}
	watched := make(map[string]struct{}, len(a.autoUpdate.dependabotWatch))
	for key := range a.autoUpdate.dependabotWatch {
		watched[key] = struct{}{}
	}
	a.autoUpdate.dependabotWatchMu.Unlock()

	byKey := make(map[string]PullRequest, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		byKey[dependabotPRKey(pr)] = pr
	}

	for key := range watched {
		pr, stillOpen := byKey[key]
		if !stillOpen {
			a.clearDependabotWatch(key)

			continue
		}

		switch pr.CI {
		case CIFailure:
			a.recreateDependabotPR(ctx, pr)
			a.clearDependabotWatch(key)
		case CISuccess:
			a.clearDependabotWatch(key)
		case CIPending, CINone:
			// Still waiting on this rebase's own CI run — check again next refresh.
		}
	}
}

// clearDependabotWatch stops reconcileDependabotRebaseWatch tracking the
// pull request key identifies.
func (a *Aggregator) clearDependabotWatch(key string) {
	a.autoUpdate.dependabotWatchMu.Lock()
	delete(a.autoUpdate.dependabotWatch, key)
	a.autoUpdate.dependabotWatchMu.Unlock()
}

// recreateDependabotPR posts DependabotRecreateComment on pr. A failure is
// logged the same way rebaseDependabotPR's own comment failure already is.
func (a *Aggregator) recreateDependabotPR(ctx context.Context, pr PullRequest) {
	commenter := a.commenterFor(pr.Forge)
	if commenter == nil {
		return
	}
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return
	}
	if err := commenter.CommentPullRequest(ctx, owner, name, pr.Number, DependabotRecreateComment); err != nil {
		slog.Warn("auto-update-branch: dependabot recreate failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)
	}
}

// labelRenovatePR adds label to pr — Renovate's own rebase/retry trigger,
// the same label the manual Renovate: Rebase button adds
// (RenovateRebaseLabelOrDefault), instead of the generic UpdateBranch call
// runAutoUpdateBranch uses for a plain pull request. A failure is logged
// the same way UpdateBranch's own failure already is; no crash, no PR left
// mid-update.
func (a *Aggregator) labelRenovatePR(ctx context.Context, pr PullRequest, label string) {
	labeler := a.labelerFor(pr.Forge)
	if labeler == nil {
		return
	}
	owner, name, ok := strings.Cut(pr.Repo, "/")
	if !ok {
		return
	}
	if err := labeler.AddLabel(ctx, owner, name, pr.Number, label); err != nil {
		slog.Warn("auto-update-branch: renovate rebase label failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "label", label, "error", err)
	}
}

// commenterFor returns the configured Source driving forge, if it supports
// PullRequestCommenter — the same "just skip it" shape branchUpdaterFor uses.
func (a *Aggregator) commenterFor(forge Forge) PullRequestCommenter {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if c, ok := src.(PullRequestCommenter); ok {
			return c
		}

		return nil
	}

	return nil
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

// labelerFor returns the configured Source driving forge, if it supports
// PullRequestLabeler — the same "just skip it" shape branchUpdaterFor uses.
func (a *Aggregator) labelerFor(forge Forge) PullRequestLabeler {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		if l, ok := src.(PullRequestLabeler); ok {
			return l
		}

		return nil
	}

	return nil
}
