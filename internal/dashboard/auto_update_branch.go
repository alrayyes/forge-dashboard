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
	// RenovateAuthors reports the logins userID has said are Renovate's
	// (Settings), so a Forgejo or GitLab Renovate account is recognised
	// (#1062).
	RenovateAuthors(ctx context.Context, userID []byte) ([]string, error)
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

	// dependabotAttempted holds every Dependabot pull request this hook has
	// already sent a rebase to and that hasn't yet stopped being Behind (or
	// left the snapshot). Unlike dependabotWatch it survives the recreate
	// that clears the watch: a rebase or recreate that worked clears Behind,
	// so a pull request still Behind means Dependabot refused (no push
	// access on the repo) and asking again can only loop (#660). Guarded by
	// dependabotWatchMu.
	dependabotAttempted map[string]struct{}

	// updateAttempts remembers the last generic UpdateBranch call per pull
	// request (#895), so a refused one isn't repeated on every refresh. A
	// refresh runs this hook several times a minute (a webhook, the CI poll,
	// every open tab asking for one), and production logged the same
	// conflicted pull request retried about every two seconds. Guarded by
	// updateMu.
	updateMu       sync.Mutex
	updateAttempts map[string]updateAttempt
}

// updateAttempt is one generic UpdateBranch call. It stands until the pull
// request changes (its UpdatedAt moves), the wait is up, or the pull request
// stops being behind.
type updateAttempt struct {
	updatedAt time.Time
	at        time.Time
	wait      time.Duration
}

const (
	// refusedUpdateWait is how long a refusal the forge gave for good reason
	// (a conflict, nothing new on the base) stands without the pull request
	// changing.
	refusedUpdateWait = time.Hour
	// transientUpdateWait covers an update still in flight and any other
	// failure: a timeout or a rate limit may clear soon, so try again, but
	// not on every refresh.
	transientUpdateWait = 5 * time.Minute
)

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
	a.autoUpdate = &autoUpdateBranchConfig{userID: userID, lister: lister, dependabotWatch: make(map[string]struct{}), dependabotAttempted: make(map[string]struct{}), updateAttempts: make(map[string]updateAttempt)}
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
	a.pruneDependabotAttempts(snap)
	a.pruneUpdateAttempts(snap)

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

	renovateAuthors, err := a.autoUpdate.lister.RenovateAuthors(ctx, a.autoUpdate.userID)
	if err != nil {
		slog.Warn("auto-update-branch: could not load renovate authors", "error", err)

		return
	}

	for _, pr := range snap.PullRequests {
		// Nothing can be done with a draft (#791), and its branch is still
		// being worked on.
		if !pr.Behind || pr.Draft {
			continue
		}
		if _, ok := enabled[string(pr.Forge)+"/"+pr.Repo]; !ok {
			continue
		}
		if isReleasePleasePR(pr) {
			continue
		}

		a.updateBehindPR(ctx, pr, renovateLabel, renovateAuthors)
	}
}

// updateBehindPR brings pr up to date the way its author calls for: a
// Dependabot pull request gets DependabotRebaseComment, a Renovate one
// gets renovateLabel added, and anything else gets the generic
// UpdateBranch — runAutoUpdateBranch's own per-PR routing, split out only
// to keep that loop's own branching under gocyclo's threshold.
func (a *Aggregator) updateBehindPR(ctx context.Context, pr PullRequest, renovateLabel string, renovateAuthors []string) {
	if isDependabotPR(pr) {
		a.rebaseDependabotPR(ctx, pr)

		return
	}

	if isRenovatePR(pr, renovateAuthors) {
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
	if !a.beginUpdate(pr) {
		return
	}
	if _, err := updater.UpdateBranch(ctx, owner, name, pr.Number); err != nil {
		a.failedUpdate(pr, err)
		slog.Warn("auto-update-branch failed", "forge", pr.Forge, "repo", pr.Repo, "number", pr.Number, "error", err)

		return
	}
	a.clearUpdate(pr)
}

// beginUpdate reports whether pr may be sent an UpdateBranch now, and
// records the attempt before the call so a concurrent run of this hook sees
// it. False while an earlier attempt stands: same pull request, wait not up.
func (a *Aggregator) beginUpdate(pr PullRequest) bool {
	key := dependabotPRKey(pr)

	a.autoUpdate.updateMu.Lock()
	defer a.autoUpdate.updateMu.Unlock()

	if prev, ok := a.autoUpdate.updateAttempts[key]; ok && prev.updatedAt.Equal(pr.UpdatedAt) && time.Since(prev.at) < prev.wait {
		return false
	}
	a.autoUpdate.updateAttempts[key] = updateAttempt{updatedAt: pr.UpdatedAt, at: time.Now(), wait: transientUpdateWait}

	return true
}

// failedUpdate stretches the wait for a refusal the forge gave for good
// reason: retrying a conflict can't help until the pull request changes.
func (a *Aggregator) failedUpdate(pr PullRequest, err error) {
	if clientErr, ok := errors.AsType[*ClientError](err); !ok || clientErr.Kind != ForgeErrorConflict {
		return
	}

	key := dependabotPRKey(pr)
	a.autoUpdate.updateMu.Lock()
	defer a.autoUpdate.updateMu.Unlock()
	if attempt, ok := a.autoUpdate.updateAttempts[key]; ok {
		attempt.wait = refusedUpdateWait
		a.autoUpdate.updateAttempts[key] = attempt
	}
}

// clearUpdate forgets a successful attempt, so the pull request is treated
// as new the next time it falls behind.
func (a *Aggregator) clearUpdate(pr PullRequest) {
	a.autoUpdate.updateMu.Lock()
	defer a.autoUpdate.updateMu.Unlock()
	delete(a.autoUpdate.updateAttempts, dependabotPRKey(pr))
}

// pruneUpdateAttempts drops the record of every pull request that is no
// longer behind, or no longer in the snapshot.
func (a *Aggregator) pruneUpdateAttempts(snap Snapshot) {
	behind := make(map[string]struct{}, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		if pr.Behind {
			behind[dependabotPRKey(pr)] = struct{}{}
		}
	}

	a.autoUpdate.updateMu.Lock()
	defer a.autoUpdate.updateMu.Unlock()
	for key := range a.autoUpdate.updateAttempts {
		if _, ok := behind[key]; !ok {
			delete(a.autoUpdate.updateAttempts, key)
		}
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
//
// A pull request already being watched is skipped entirely — confirmed
// live as a real incident (alrayyes/forgejo-time-sync#77): a rebase
// Dependabot silently refuses (no push access on the repo, replying
// "Sorry, only users with push access can use that command.") never
// clears Behind and never moves its CI, so runAutoUpdateBranch's own
// per-refresh loop kept finding the same still-behind pull request and
// asking again — 670 rebase comments over 4+ hours, one per
// webhook-triggered refresh, each Dependabot reply itself triggering
// another refresh. reconcileDependabotRebaseWatch (run earlier in the
// same refresh, see runAutoUpdateBranch) is the only thing that gets to
// decide what happens to a watched pull request next: escalate once its
// CI actually resolves, or leave it watched. Asking again here on every
// refresh while that's still pending bypasses that decision entirely.
func (a *Aggregator) rebaseDependabotPR(ctx context.Context, pr PullRequest) {
	if a.isDependabotWatched(dependabotPRKey(pr)) || a.wasDependabotAttempted(dependabotPRKey(pr)) {
		return
	}

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
	a.autoUpdate.dependabotAttempted[dependabotPRKey(pr)] = struct{}{}
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

// pruneDependabotAttempts forgets every attempt whose pull request is no
// longer Behind or no longer in snap, so a later Behind is a fresh request.
func (a *Aggregator) pruneDependabotAttempts(snap Snapshot) {
	behind := make(map[string]struct{}, len(snap.PullRequests))
	for _, pr := range snap.PullRequests {
		if pr.Behind {
			behind[dependabotPRKey(pr)] = struct{}{}
		}
	}

	a.autoUpdate.dependabotWatchMu.Lock()
	defer a.autoUpdate.dependabotWatchMu.Unlock()
	for key := range a.autoUpdate.dependabotAttempted {
		if _, ok := behind[key]; !ok {
			delete(a.autoUpdate.dependabotAttempted, key)
		}
	}
}

// wasDependabotAttempted reports whether a rebase was already sent for key
// while it has stayed Behind.
func (a *Aggregator) wasDependabotAttempted(key string) bool {
	a.autoUpdate.dependabotWatchMu.Lock()
	defer a.autoUpdate.dependabotWatchMu.Unlock()
	_, ok := a.autoUpdate.dependabotAttempted[key]

	return ok
}

// clearDependabotWatch stops reconcileDependabotRebaseWatch tracking the
// pull request key identifies.
func (a *Aggregator) clearDependabotWatch(key string) {
	a.autoUpdate.dependabotWatchMu.Lock()
	delete(a.autoUpdate.dependabotWatch, key)
	a.autoUpdate.dependabotWatchMu.Unlock()
}

// isDependabotWatched reports whether key is currently being watched —
// rebaseDependabotPR's own guard against re-posting a rebase comment for
// a pull request reconcileDependabotRebaseWatch hasn't resolved yet.
func (a *Aggregator) isDependabotWatched(key string) bool {
	a.autoUpdate.dependabotWatchMu.Lock()
	defer a.autoUpdate.dependabotWatchMu.Unlock()
	_, ok := a.autoUpdate.dependabotWatch[key]

	return ok
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
	if _, err := RequestRenovateRebase(ctx, labeler, labeler, owner, name, pr.Number, label); err != nil {
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
		if DependabotCommandsBlockedReason(src) != "" {
			return nil
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
