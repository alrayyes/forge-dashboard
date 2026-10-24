package dashboard

import "strconv"

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
}

// AllowedActions works out which actions a pull request offers, from the
// pull request's own fields (#805). It holds what the page used to decide for
// itself, so every client gets the same answer. Live state stays with the
// client: a rate-limited or unreachable forge, a missing token, an action
// already in flight.
func AllowedActions(pr PullRequest, renovateAuthors []string) []ActionAvailability {
	out := []ActionAvailability{}
	// An empty pull request can't become mergeable by waiting, so it offers no
	// Merge at all, only Close. PullRequestStatus says why (#1375).
	if !pr.Empty {
		out = append(out, mergeAvailability(pr))
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
	if pr.Forge == ForgeGitHub && isDependabotPR(pr) {
		// A command Dependabot has yet to act on can't be withdrawn, so while one
		// is pending neither is offered; the wait chip says what is going on.
		if !botRequestPending(pr, BotDependabot) {
			out = append(out, ActionAvailability{Action: ActionDependabotRebase}, ActionAvailability{Action: ActionDependabotRecreate})
		}
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
		case a.Blocked == nil && pr.CI != CIFailure:
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

// botRebaseWorthOffering: a behind pull request can be rebased unless a
// conflict needs a person, it is a draft, or it is stacked on another one.
// Only a bot pull request lists a bot rebase, so the caller's candidates
// name nothing for any other.
func botRebaseWorthOffering(pr PullRequest) bool {
	return pr.Behind && pr.MergeStatus != MergeConflicting && !pr.Draft && pr.StackedOn == nil
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

// renovateRebaseActions: a rebase already asked for is not asked for again. When
// it was asked for through the rebase box, clearing the box withdraws it, so
// that is offered instead. A request made another way (the label fallback) has
// no way back, so a pending one leaves neither action and the wait chip says
// what is going on. Renovate clears the box once it has rebased, and the next
// snapshot offers the rebase again.
func renovateRebaseActions(pr PullRequest) []ActionAvailability {
	switch {
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
func mergeAvailability(pr PullRequest) ActionAvailability {
	switch {
	case pr.StackedOn != nil:
		// Merging it would land it in the parent's branch, not the base it
		// will end up on (#860). It outranks the other reasons: it is the one
		// that stays until the parent merges.
		parent := "#" + strconv.Itoa(pr.StackedOn.Number)

		return mergeBlocked(ActionStacked, "Stacked on "+parent+". Merge that one first.",
			"Merge unlocks once "+parent+" merges and this pull request is retargeted.")
	case pr.MergeStatus == MergeConflicting:
		return mergeBlocked(ActionConflict, "Merge conflict", "Resolve it on the forge to unlock Merge")
	case pr.Draft:
		return mergeBlocked(ActionNotMergeable, "Draft pull request", "Mark it ready for review to unlock Merge")
	case pr.MergeStatus == MergeUnstable:
		// GitHub says it can merge: only checks branch protection doesn't
		// require are failing or running (#955, #956). Required ones would
		// make it BLOCKED. Skips the CI rules below.
		return ActionAvailability{Action: ActionMerge}
	case pr.CI == CIPending:
		// Overrides a forge that says mergeable while checks still run (#385).
		// With auto-merge armed the wait chip already says what happens next,
		// so a second line would repeat it (#1638).
		next := "Merge unlocks automatically"
		if pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled {
			next = ""
		}

		return mergeBlocked(ActionChecksPending, "Waiting for CI to finish", next)
	case heldForApproval(pr):
		// Held runs report nothing until a maintainer approves them (#1929),
		// so "CI is failing" would send the user the wrong way. Bringing a
		// behind branch up to date would only make a new held head, so this
		// is the reason to give ahead of being behind.
		r := approvalReason()

		return mergeBlocked(r.Code, r.Message, r.Next)
	case pr.Behind && pr.MergeStatus != MergeMergeable:
		return mergeBlocked(ActionBehind, "Behind the base branch", "Bring it up to date to unlock Merge")
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
		return mergeBlocked(ActionChecksFailing, "Blocked, CI is failing", "Fix the failing check to unlock Merge")
	case pr.MergeStatus == MergeBlocked:
		return mergeBlocked(ActionBlockedByProtection, "Blocked by the forge", "A required check or review is missing")
	case pr.MergeStatus != MergeMergeable:
		return mergeBlocked(ActionNotMergeable, "Merge status not known yet", "Merge unlocks once the forge reports it")
	}

	return ActionAvailability{Action: ActionMerge}
}

// updateBranchAvailability: only a pull request that is behind and has
// something to merge. Dependabot and Renovate pull requests use their own
// rebase instead; release-please keeps this one.
func updateBranchAvailability(pr PullRequest, renovateAuthors []string) (ActionAvailability, bool) {
	if !pr.Behind || pr.Empty {
		return ActionAvailability{}, false
	}
	if (isDependabotPR(pr) || isRenovatePR(pr, renovateAuthors)) && !isReleasePleasePR(pr) {
		return ActionAvailability{}, false
	}
	if pr.MergeStatus == MergeConflicting {
		return ActionAvailability{Action: ActionUpdateBranch, Blocked: &Blocked{
			Code:    ActionConflict,
			Message: "Conflicts need fixing by hand — resolve them on the forge.",
		}}, true
	}

	// While Merge waits for CI, a branch update would only restart the checks
	// it is waiting for. Listed blocked with Merge's own reason, so the board
	// hides it and the API and a queued run refuse it truthfully.
	if m := mergeAvailability(pr); m.Blocked != nil && m.Blocked.Code == ActionChecksPending {
		return ActionAvailability{Action: ActionUpdateBranch, Blocked: m.Blocked}, true
	}

	return ActionAvailability{Action: ActionUpdateBranch}, true
}

// autoMergeOffered: GitHub, or Forgejo where this app holds the intent, and not
// when it is already on (nil means the forge can't say, which isn't "on"),
// when GitHub says it would refuse (nil isn't a refusal, #738), when there is
// nothing to merge, when conflicts need fixing first, or when the pull request
// is clean and Merge covers it (#662). A Forgejo draft can't merge yet, so
// there is nothing to arm.
func autoMergeOffered(pr PullRequest) bool {
	switch {
	case pr.Forge != ForgeGitHub && pr.Forge != ForgeForgejo:
		return false
	case pr.Forge == ForgeForgejo && pr.Draft:
		return false
	case pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled:
		return false
	case pr.AutoMergeAllowed != nil && !*pr.AutoMergeAllowed:
		return false
	case pr.Empty, pr.MergeStatus == MergeConflicting:
		return false
	case pr.StackedOn != nil:
		// Its base is the parent's branch, which has nothing to wait for, so
		// GitHub offers no auto-merge either (#860).
		return false
	case pr.MergeStatus == MergeMergeable && pr.CI == CISuccess && !pr.Behind:
		return false
	}

	return true
}
