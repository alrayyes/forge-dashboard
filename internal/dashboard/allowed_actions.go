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
	ActionRerunChecks        ActionName = "rerun_checks"
	ActionCancelRun          ActionName = "cancel_run"
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
		out = append(out, dependabotRebaseAvailability(pr), dependabotRecreateAvailability(pr))
	}
	if isRenovatePR(pr, renovateAuthors) {
		out = append(out, renovateRebaseAvailability(pr))
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
	markPrimary(pr, out)

	return out
}

// markPrimary sets Primary on the one action that is the pull request's main
// button, so no client decides it. The rule table, first match wins:
//   - empty: Close, since nothing can ever merge;
//   - Merge offered and not blocked: Merge, unless CI is failing (Merge is
//     only open because the failing checks aren't required, and the status
//     area explains that);
//   - Merge blocked because the branch is behind: Update branch, or the
//     Renovate or Dependabot rebase for a bot pull request, whichever is
//     offered and not blocked;
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
			return append([]ActionName{ActionUpdateBranch}, botRebases(pr)...)
		// Merge is blocked for another reason, or open only because the failing
		// checks aren't required: the rule is the same.
		case botRebaseWorthOffering(pr):
			return botRebases(pr)
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

// botRebases is the bot rebases that may be primary. Runs held for workflow
// approval report nothing until a maintainer approves them, and a rebase can't
// do that, so none is offered then and Merge's reason stays in the status.
func botRebases(pr PullRequest) []ActionName {
	if pr.AwaitingWorkflowApproval {
		return nil
	}

	return []ActionName{ActionRenovateRebase, ActionDependabotRebase}
}

// dependabotRebaseAvailability: a Recreate that is pending rebuilds the whole
// pull request, so a Rebase beside it has no point until it is done.
func dependabotRebaseAvailability(pr PullRequest) ActionAvailability {
	return dependabotLock(ActionDependabotRebase, pr, BotRecreate, "Recreate")
}

// dependabotRecreateAvailability: a Recreate over a pending Rebase would throw
// its work away, so it waits until the Rebase is done.
func dependabotRecreateAvailability(pr PullRequest) ActionAvailability {
	return dependabotLock(ActionDependabotRecreate, pr, BotRebase, "Rebase")
}

// dependabotLock blocks action while the other Dependabot command is pending,
// and names it. An expired request has settled and locks nothing.
func dependabotLock(action ActionName, pr PullRequest, other BotAction, otherName string) ActionAvailability {
	req := pr.BotRequest
	if req == nil || req.Bot != BotDependabot || req.Action != other || (req.Phase != BotQueued && req.Phase != BotRebasing) {
		return ActionAvailability{Action: action}
	}

	return ActionAvailability{Action: action, Blocked: &Blocked{
		Code:    ActionAlreadyRequested,
		Message: "A Dependabot " + otherName + " is pending on this pull request.",
		Next:    "It unlocks once Dependabot has finished.",
	}}
}

// renovateRebaseAvailability: while Renovate's rebase box is ticked, a rebase is
// already waiting for it, so asking again is blocked with the reason (#1349).
// Renovate clears the box once it has rebased, and the next snapshot offers the
// action again. The box can be ticked here or on the forge; the snapshot reads
// it from the description either way.
func renovateRebaseAvailability(pr PullRequest) ActionAvailability {
	if !pr.RenovateRebaseRequested {
		return ActionAvailability{Action: ActionRenovateRebase}
	}

	return ActionAvailability{Action: ActionRenovateRebase, Blocked: &Blocked{
		Code:    ActionAlreadyRequested,
		Message: "A Renovate rebase is already requested on this pull request.",
		Next:    "Renovate clears the box once it has rebased, and the rebase is offered again.",
	}}
}

// mergeAvailability is Merge's rules in the order they apply. Merge is blocked
// rather than hidden while waiting or fixing something can unlock it. Only an
// empty pull request, which nothing can unlock, is left without it.
func mergeAvailability(pr PullRequest) ActionAvailability {
	blocked := func(code ActionCode, message, next string) ActionAvailability {
		return ActionAvailability{Action: ActionMerge, Blocked: &Blocked{Code: code, Message: message, Next: next}}
	}

	switch {
	case pr.StackedOn != nil:
		// Merging it would land it in the parent's branch, not the base it
		// will end up on (#860). It outranks the other reasons: it is the one
		// that stays until the parent merges.
		parent := "#" + strconv.Itoa(pr.StackedOn.Number)

		return blocked(ActionStacked, "Stacked on "+parent+". Merge that one first.",
			"Merge unlocks once "+parent+" merges and this pull request is retargeted.")
	case pr.MergeStatus == MergeConflicting:
		return blocked(ActionConflict, "Merge conflict", "Resolve it on the forge to unlock Merge")
	case pr.Draft:
		return blocked(ActionNotMergeable, "Draft pull request", "Mark it ready for review to unlock Merge")
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

		return blocked(ActionChecksPending, "Waiting for CI to finish", next)
	case pr.MergeStatus == MergeBlocked && pr.CI == CIFailure && pr.AwaitingWorkflowApproval:
		// Held runs report nothing until a maintainer approves them (#1929),
		// so "CI is failing" would send the user the wrong way. Bringing a
		// behind branch up to date would only make a new held head, so this
		// is the reason to give ahead of being behind.
		return blocked(ActionBlockedByProtection, "Workflow runs are waiting for approval", "Approve them on GitHub to unlock Merge")
	case pr.Behind && pr.MergeStatus != MergeMergeable:
		return blocked(ActionBehind, "Behind the base branch", "Bring it up to date to unlock Merge")
	default:
		return forgeMergeAvailability(pr, blocked)
	}
}

// forgeMergeAvailability is the last of Merge's rules: what the forge itself
// says once the pull request is not stacked, conflicting, a draft, waiting on
// CI or behind.
func forgeMergeAvailability(pr PullRequest, blocked func(ActionCode, string, string) ActionAvailability) ActionAvailability {
	switch {
	case pr.MergeStatus == MergeBlocked && pr.CI == CIFailure:
		return blocked(ActionChecksFailing, "Blocked, CI is failing", "Fix the failing check to unlock Merge")
	case pr.MergeStatus == MergeBlocked:
		return blocked(ActionBlockedByProtection, "Blocked by the forge", "A required check or review is missing")
	case pr.MergeStatus != MergeMergeable:
		return blocked(ActionNotMergeable, "Merge status not known yet", "Merge unlocks once the forge reports it")
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
