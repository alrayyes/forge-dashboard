package dashboard

import (
	"strconv"
	"time"
)

// ActionName is one thing a client can do to a pull request. Matches
// components.schemas.AllowedAction.action.
type ActionName string

// The actions a pull request can offer.
const (
	ActionMerge              ActionName = "merge"
	ActionClose              ActionName = "close"
	ActionUpdateBranch       ActionName = "update_branch"
	ActionAutoMerge          ActionName = "auto_merge"
	ActionCancelAutoMerge    ActionName = "cancel_auto_merge"
	ActionDependabotRebase   ActionName = "dependabot_rebase"
	ActionDependabotRecreate ActionName = "dependabot_recreate"
	ActionRenovateRebase     ActionName = "renovate_rebase"
	// ActionCancelRenovateRebase withdraws a rebase asked for through Renovate's
	// rebase box, by clearing the box.
	ActionCancelRenovateRebase ActionName = "cancel_renovate_rebase"
	ActionRerunChecks          ActionName = "rerun_checks"
	ActionCancelRun            ActionName = "cancel_run"
)

// ActionAvailability says one action applies to a pull request and, when it
// can't be taken yet, why. An action that doesn't apply at all (Update branch
// on a pull request that isn't behind, a Dependabot command on a Renovate PR)
// is absent from the list rather than listed as blocked. Matches
// components.schemas.AllowedAction.
type ActionAvailability struct {
	Action  ActionName `json:"action"`
	Blocked *Blocked   `json:"blocked,omitempty"`
	// Primary marks the one action a client draws as the main button. At most
	// one entry per pull request has it, and never a blocked one.
	Primary bool `json:"primary,omitempty"`
}

// Blocked is why an offered action can't be taken right now. Code comes from
// the same set as ActionError.code. Message is plain words for a person, and
// Next says what unlocks it, when something does.
type Blocked struct {
	Code    ActionCode `json:"code"`
	Message string     `json:"message"`
	Next    string     `json:"next,omitempty"`
	// Since is when the rows on show were read, set only with
	// ActionForgeUnreachable and only when the dashboard knows.
	Since *time.Time `json:"since,omitempty"`
}

// AllowedActions works out which actions a pull request offers, from the
// pull request's own fields (#805). It holds what the page used to decide for
// itself, so every client gets the same answer. Live state stays with the
// client: a rate-limited or unreachable forge, a missing token, an action
// already in flight.
func AllowedActions(pr PullRequest, renovateAuthors []string) []ActionAvailability {
	return AllowedActionsOn(pr, renovateAuthors, ForgeHealth{Reachable: true})
}

// AllowedActionsOn is AllowedActions for a pull request whose forge has the
// given health. While the forge can't be asked the row is an earlier answer
// and no action can run, so every action is blocked with the reason the claim
// rule gives, whatever the earlier answer said (#3994). Nothing else of the forge's
// health, a spent budget included, is read here.
func AllowedActionsOn(pr PullRequest, renovateAuthors []string, h ForgeHealth) []ActionAvailability {
	out := allowedActions(pr, renovateAuthors)
	if claim := ClaimOf(ClaimAction, h, true); !claim.ActionsOpen {
		for i := range out {
			out[i].Primary = false
			out[i].Blocked = &Blocked{Code: ActionForgeUnreachable, Message: claim.Reason, Since: claim.Since}
		}
	}

	return out
}

func allowedActions(pr PullRequest, renovateAuthors []string) []ActionAvailability {
	out := []ActionAvailability{}
	// An empty pull request can't become mergeable by waiting, so it offers no
	// Merge at all, only Close. PullRequestStatus says why (#1375).
	if !pr.Empty {
		out = append(out, mergeAvailability(pr, renovateAuthors))
	}
	out = append(out, ActionAvailability{Action: ActionClose})
	if a, ok := updateBranchAvailability(pr, renovateAuthors); ok {
		out = append(out, a)
	}
	if autoMergeOffered(pr) {
		out = append(out, ActionAvailability{Action: ActionAutoMerge})
	}
	// Armed on either forge: Forgejo's intent is this app's own, GitHub's is
	// turned off with disablePullRequestAutoMerge (#1293).
	if pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled {
		out = append(out, ActionAvailability{Action: ActionCancelAutoMerge})
	}
	if answersDependabot(pr.Forge) && isDependabotPR(pr) {
		out = append(out, dependabotActions(pr)...)
	}
	if isRenovatePR(pr, renovateAuthors) {
		out = append(out, renovateRebaseActions(pr)...)
	}
	// Failed checks can be rerun on either forge. The list only knows the CI
	// is failing, not whether an Actions run is behind it, so a Forgejo pull
	// request on an external CI offers it and the rerun answers that there is
	// nothing to rerun.
	// A pull request held only for workflow approval has no failed run to rerun.
	if IsFailingCI(pr) {
		out = append(out, ActionAvailability{Action: ActionRerunChecks})
	}
	// A pipeline that is still going can be cancelled, a run at a time. A job
	// that already failed rolls the CI up to failing while the others still run,
	// which is when cancelling a doomed pipeline matters most, so a running or
	// waiting check counts as well as a pending roll-up. The list can't tell
	// whether an Actions run is behind them, so the pipeline dialog offers
	// Cancel only on checks that name a run.
	if pr.CI == CIPending || pr.Checks.Running > 0 || pr.Checks.Waiting > 0 {
		out = append(out, ActionAvailability{Action: ActionCancelRun})
	}
	blockHeadPushes(pr, out)
	markPrimary(pr, out)

	return out
}

// dependabotActions: the commands Dependabot answers. A command it has yet to
// act on can't be withdrawn, so while one is pending neither is offered; the
// wait chip says what is going on. It refuses a rebase on a branch someone else
// committed to (#4023), so only Recreate, which discards those commits, is
// offered there.
func dependabotActions(pr PullRequest) []ActionAvailability {
	if botRequestPending(pr, BotDependabot) {
		return nil
	}

	var out []ActionAvailability
	if !pr.EditedByOthers {
		out = append(out, ActionAvailability{Action: ActionDependabotRebase})
	}

	return append(out, ActionAvailability{Action: ActionDependabotRecreate})
}

// mergeHeldForApproval: Merge is offered and gives the approval as its reason.
// Merge's own rules (empty, stacked, draft, pending checks, the forge's merge
// state) decide that, so a head push is held back only where Merge says so.
func mergeHeldForApproval(actions []ActionAvailability) bool {
	for _, a := range actions {
		if a.Action == ActionMerge {
			return a.Blocked != nil && *a.Blocked == approvalReason()
		}
	}

	return false
}

// blockHeadPushes lists the actions that push a new head blocked with the
// approval reason, since that head would be held again. Only a behind pull
// request has such an action to run. An action already blocked for its own
// reason keeps it.
func blockHeadPushes(pr PullRequest, actions []ActionAvailability) {
	if !pr.Behind || !mergeHeldForApproval(actions) {
		return
	}
	for i := range actions {
		switch actions[i].Action {
		case ActionUpdateBranch, ActionRenovateRebase, ActionDependabotRebase, ActionDependabotRecreate:
			if actions[i].Blocked == nil {
				actions[i].Blocked = &Blocked{
					Code:    ActionBlockedByProtection,
					Message: approvalReason().Message,
					Next:    HeadPushBlockedNext,
				}
			}
		default:
		}
	}
}

// HeadPushBlockedNext is what an action that would push a held head says
// unlocks it. It is not Merge's text: these actions unlock nothing but themselves.
const HeadPushBlockedNext = "Approve them on GitHub, then this can run"

func approvalReason() Blocked {
	return Blocked{Code: ActionBlockedByProtection, Message: "Workflow runs are waiting for approval", Next: "Approve them on GitHub to unlock Merge"}
}

// markPrimary sets Primary on the one action that is the pull request's main
// button, so no client decides it. The rule table, first match wins:
//   - empty: Close, since nothing can ever merge;
//   - Merge offered and not blocked: Merge, unless CI is failing (Merge is
//     only open because the failing checks aren't required, and the status
//     area explains that);
//   - Merge blocked because the branch is behind: Update branch, or the
//     Renovate or Dependabot rebase for a bot pull request, whichever is
//     offered and not blocked. Not when runs wait for workflow approval, for a
//     bot or anyone else: Merge then gives the approval as its reason, since a
//     new head would be held again;
//   - a bot pull request that is behind, and neither conflicting, a draft nor
//     stacked, whatever else holds Merge back (checks running or failing,
//     auto-merge armed): the bot's rebase, since a stale branch is worth
//     fixing while it waits. Runs held for workflow approval are the
//     exception, as a rebase can't release them;
//   - anything else (checks running or failing, conflict, draft, stacked,
//     blocked by the forge): none, since the status area gives the reason.
func markPrimary(pr PullRequest, actions []ActionAvailability) {
	for _, name := range primaryCandidates(pr, actions) {
		for i := range actions {
			if actions[i].Action == name && actions[i].Blocked == nil {
				actions[i].Primary = true

				return
			}
		}
	}
}

// primaryCandidates is the actions that may be primary, best first.
func primaryCandidates(pr PullRequest, actions []ActionAvailability) []ActionName {
	if pr.Empty {
		return []ActionName{ActionClose}
	}
	for _, a := range actions {
		if a.Action != ActionMerge {
			continue
		}
		switch {
		case a.Blocked == nil && pr.CI != CIFailure && pr.CI != CICancelled:
			return []ActionName{ActionMerge}
		case a.Blocked != nil && a.Blocked.Code == ActionBehind:
			return append([]ActionName{ActionUpdateBranch}, botRebases()...)
		// Merge is blocked for another reason, or open only because the failing
		// checks aren't required: the rule is the same.
		case botRebaseWorthOffering(pr):
			return botRebases()
		}
	}

	return nil
}

// conflictKnown is a conflict a person has to fix by hand. A Forgejo row that
// is Conflicting only because its flag stayed false (ConflictConfirmed false)
// is not: updating the branch is how it finds out, and a refusal that names a
// conflict makes it known (#3308).
func conflictKnown(pr PullRequest) bool {
	return pr.MergeStatus == MergeConflicting && (pr.ConflictConfirmed == nil || *pr.ConflictConfirmed)
}

// botRebaseWorthOffering: a behind pull request can be rebased unless a
// conflict needs a person, it is a draft, or it is stacked on another one.
// Only a bot pull request lists a bot rebase, so the caller's candidates
// name nothing for any other.
func botRebaseWorthOffering(pr PullRequest) bool {
	return pr.Behind && !conflictKnown(pr) && !pr.Draft && pr.StackedOn == nil
}

// heldForApproval: runs wait for a maintainer and nothing else explains why
// Merge is closed: the forge says blocked or hasn't said yet, and the checks
// aren't running. Merge gives that as its reason, ahead of being behind, since
// a new head would be held again. Pending checks are a plain wait and stay
// their own reason.
func heldForApproval(pr PullRequest) bool {
	return pr.AwaitingWorkflowApproval && pr.CI != CIPending &&
		(pr.MergeStatus == MergeBlocked || pr.MergeStatus == MergeUnknown)
}

// botRebases is the bot rebases that may be primary. A held behind pull
// request lists them blocked, and markPrimary skips blocked actions.
func botRebases() []ActionName {
	return []ActionName{ActionRenovateRebase, ActionDependabotRebase}
}

// botRequestPending: bot has been asked for something it hasn't finished. An
// expired request has settled and counts for nothing.
func botRequestPending(pr PullRequest, bot BotName) bool {
	req := pr.BotRequest

	return req != nil && req.Bot == bot && (req.Phase == BotQueued || req.Phase == BotRebasing)
}

func renovateRebasing(pr PullRequest) bool {
	req := pr.BotRequest

	return req != nil && req.Bot == BotRenovate && req.Phase == BotRebasing
}

// renovateRebaseActions: a rebase already asked for is not asked for again. When
// it was asked for through the rebase box, clearing the box withdraws it, so
// that is offered instead. A request made another way (the label fallback) has
// no way back, so a pending one leaves neither action and the wait chip says
// what is going on. Renovate clears the box once it has rebased, and the next
// snapshot offers the rebase again.
func renovateRebaseActions(pr PullRequest) []ActionAvailability {
	switch {
	case renovateRebasing(pr):
		// Renovate has consumed the box, so clearing it withdraws nothing and
		// would drop the in-progress record.
		return nil
	case pr.RenovateRebaseRequested:
		return []ActionAvailability{{Action: ActionCancelRenovateRebase}}
	case botRequestPending(pr, BotRenovate):
		return nil
	default:
		return []ActionAvailability{{Action: ActionRenovateRebase}}
	}
}

// mergeAvailability is Merge's rules in the order they apply. Merge is blocked
// rather than hidden while waiting or fixing something can unlock it. Only an
// empty pull request, which nothing can unlock, is left without it.
func mergeAvailability(pr PullRequest, renovateAuthors []string) ActionAvailability {
	switch {
	case pr.StackedOn != nil:
		// Merging it would land it in the parent's branch, not the base it
		// will end up on (#860). It outranks the other reasons: it is the one
		// that stays until the parent merges.
		parent := "#" + strconv.Itoa(pr.StackedOn.Number)

		return mergeBlocked(ActionStacked, "Stacked on "+parent+". Merge that one first.",
			"Merge unlocks once "+parent+" merges and this pull request is retargeted.")
	case pr.MergeStatus == MergeConflicting && pr.ConflictConfirmed != nil && !*pr.ConflictConfirmed:
		// Only the forge's flag, false for a while, says so (#3308).
		return unconfirmedConflictMerge(pr, renovateAuthors)
	case pr.MergeStatus == MergeConflicting:
		return mergeBlocked(ActionConflict, "Merge conflict", "Resolve it on the forge to unlock Merge")
	case pr.MergeStatus == MergeChecking:
		// The forge's flag is false while it rechecks after a base push, the
		// same as for a conflict, so Merge waits without calling it one (#3304).
		return mergeBlocked(ActionChecksPending, "Checking for conflicts", "")
	case pr.Draft:
		return mergeBlocked(ActionNotMergeable, "Draft pull request", "")
	case pr.MergeStatus == MergeUnstable:
		// GitHub says it can merge: only checks branch protection doesn't
		// require are failing or running (#955, #956). Required ones would
		// make it BLOCKED. Skips the CI rules below.
		return ActionAvailability{Action: ActionMerge}
	case pr.CI == CIPending:
		// Overrides a forge that says mergeable while checks still run (#385).
		return mergeBlocked(ActionChecksPending, "Waiting for CI to finish", "")
	case heldForApproval(pr):
		// Held runs report nothing until a maintainer approves them (#1929),
		// so "CI is failing" would send the user the wrong way. Bringing a
		// behind branch up to date would only make a new held head, so this
		// is the reason to give ahead of being behind.
		r := approvalReason()

		return mergeBlocked(r.Code, r.Message, r.Next)
	case pr.Behind && pr.MergeStatus != MergeMergeable:
		return mergeBlocked(ActionBehind, "Behind the base branch", "")
	default:
		return forgeMergeAvailability(pr)
	}
}

// mergeBlocked is Merge listed with the reason it can't be taken yet.
func mergeBlocked(code ActionCode, message, next string) ActionAvailability {
	return ActionAvailability{Action: ActionMerge, Blocked: &Blocked{Code: code, Message: message, Next: next}}
}

// forgeMergeAvailability is the last of Merge's rules: what the forge itself
// says once the pull request is not stacked, conflicting, a draft, waiting on
// CI or behind.
func forgeMergeAvailability(pr PullRequest) ActionAvailability {
	switch {
	case pr.MergeStatus == MergeBlocked && pr.CI == CIFailure:
		return mergeBlocked(ActionChecksFailing, "Blocked, CI is failing", "")
	case pr.MergeStatus == MergeBlocked && pr.CI == CICancelled:
		return mergeBlocked(ActionBlockedByProtection, "Blocked, the only run was cancelled", "Run the checks again to unlock Merge")
	case pr.MergeStatus == MergeBlocked:
		return mergeBlocked(ActionBlockedByProtection, "Blocked by the forge", "A required check or review is missing")
	case pr.MergeStatus != MergeMergeable:
		return mergeBlocked(ActionStatusUnknown, "Merge status not known yet", "")
	}

	return ActionAvailability{Action: ActionMerge}
}

// unconfirmedConflictMerge is Merge's block for a conflict only the forge's
// flag reports. Update branch is how it gets confirmed, so it is named only
// when the pull request offers it (#3965).
func unconfirmedConflictMerge(pr PullRequest, renovateAuthors []string) ActionAvailability {
	if _, offered := updateBranchAvailability(pr, renovateAuthors); offered {
		return mergeBlocked(ActionConflict, "Conflict not confirmed", "The forge hasn't confirmed it. Update the branch to find out")
	}

	return mergeBlocked(ActionConflict, "Conflict not confirmed", "The forge hasn't confirmed it. Wait for it to finish checking, or open the pull request on the forge")
}

// updateBranchAvailability: only a pull request that is behind and has
// something to merge. Dependabot and Renovate pull requests use their own
// rebase instead; release-please keeps this one.
func updateBranchAvailability(pr PullRequest, renovateAuthors []string) (ActionAvailability, bool) {
	if !pr.IsOutOfDate() {
		return ActionAvailability{}, false
	}
	if (isDependabotPR(pr) || isRenovatePR(pr, renovateAuthors)) && !isReleasePleasePR(pr) && !editedDependabotPR(pr) {
		return ActionAvailability{}, false
	}
	if conflictKnown(pr) {
		return ActionAvailability{Action: ActionUpdateBranch, Blocked: &Blocked{
			Code:    ActionConflict,
			Message: "Conflicts need fixing by hand — resolve them on the forge.",
		}}, true
	}

	return ActionAvailability{Action: ActionUpdateBranch}, true
}

// autoMergeOffered is whether Auto-merge is on a pull request's list: it isn't
// when AutoMergeBlock has a reason.
func autoMergeOffered(pr PullRequest) bool {
	_, blocked := AutoMergeBlock(pr)

	return !blocked
}

// AutoMergeBlock is the one rule for arming auto-merge: why it can't be armed
// on pr, in the order that matters, or false when it can. The action list and
// the arm endpoint's refusal both read it, so they can't disagree. Not armable:
// a forge this build doesn't know, an app-held draft (nothing to merge yet), one
// already on, one the forge says it would refuse (nil isn't a refusal, #738),
// nothing to merge, conflicts to fix first, a stacked pull request (#860), or
// one that is clean so Merge covers it (#662).
func AutoMergeBlock(pr PullRequest) (ActionRefusal, bool) {
	switch {
	case !AppMergesArmed(pr.Forge) && !forgeMergesArmed(pr.Forge):
		return ActionRefusal{Code: ActionNotMergeable, Message: "Auto-merge is only available on GitHub and Forgejo."}, true
	case AppMergesArmed(pr.Forge) && pr.Draft:
		return ActionRefusal{Code: ActionNotMergeable, Message: "Draft pull request. Mark it ready for review to turn on auto-merge."}, true
	case pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled:
		return ActionRefusal{Code: ActionNotMergeable, Message: "Auto-merge is already on for this pull request."}, true
	case pr.AutoMergeAllowed != nil && !*pr.AutoMergeAllowed:
		return ActionRefusal{Code: ActionAutoMergeNotAllowed, Message: "Auto-merge isn't allowed for this pull request. Turn it on in the repo's settings."}, true
	case pr.Empty:
		return ActionRefusal{Code: ActionAlreadyUpToDate, Message: "Already up to date with the target branch, so there is nothing to merge."}, true
	case pr.MergeStatus == MergeConflicting:
		return ActionRefusal{Code: ActionConflict, Message: "Merge conflict. Resolve it on the forge first."}, true
	case pr.StackedOn != nil:
		return ActionRefusal{Code: ActionStacked, Message: "Stacked on another pull request. Merge that one first."}, true
	case pr.MergeStatus == MergeMergeable && pr.CI == CISuccess && !pr.Behind:
		return ActionRefusal{Code: ActionReadyToMerge, Message: "This pull request is already ready to merge, so there's nothing for auto-merge to wait for. Use Merge instead."}, true
	}

	return ActionRefusal{}, false
}

// editedDependabotPR: a Dependabot pull request Dependabot won't rebase because
// someone else committed to its branch. The forge's own branch update works
// there, so it is that pull request's way to catch up (#4023).
func editedDependabotPR(pr PullRequest) bool {
	return isDependabotPR(pr) && pr.EditedByOthers
}
