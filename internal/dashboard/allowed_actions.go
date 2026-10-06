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
)

// ActionAvailability says one action applies to a pull request and, when it
// can't be taken yet, why. An action that doesn't apply at all (Update branch
// on a pull request that isn't behind, a Dependabot command on a Renovate PR)
// is absent from the list rather than listed as blocked. Matches
// components.schemas.AllowedAction.
type ActionAvailability struct {
	Action  ActionName `json:"action"`
	Blocked *Blocked   `json:"blocked,omitempty"`
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
func AllowedActions(pr PullRequest) []ActionAvailability {
	out := []ActionAvailability{mergeAvailability(pr), {Action: ActionClose}}
	if a, ok := updateBranchAvailability(pr); ok {
		out = append(out, a)
	}
	if autoMergeOffered(pr) {
		out = append(out, ActionAvailability{Action: ActionAutoMerge})
	}
	// Only Forgejo's auto-merge is this app's to cancel. GitHub's belongs to
	// GitHub.
	if pr.Forge == ForgeForgejo && pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled {
		out = append(out, ActionAvailability{Action: ActionCancelAutoMerge})
	}
	if pr.Forge == ForgeGitHub && isDependabotPR(pr) {
		out = append(out, ActionAvailability{Action: ActionDependabotRebase}, ActionAvailability{Action: ActionDependabotRecreate})
	}
	if isRenovatePR(pr) {
		out = append(out, ActionAvailability{Action: ActionRenovateRebase})
	}
	// Failed checks can be rerun on either forge. The list only knows the CI
	// is failing, not whether an Actions run is behind it, so a Forgejo pull
	// request on an external CI offers it and the rerun answers that there is
	// nothing to rerun.
	if pr.CI == CIFailure {
		out = append(out, ActionAvailability{Action: ActionRerunChecks})
	}

	return out
}

// mergeAvailability is Merge's rules in the order they apply. Merge is never
// hidden for an open pull request, only blocked.
func mergeAvailability(pr PullRequest) ActionAvailability {
	blocked := func(code ActionCode, message, next string) ActionAvailability {
		return ActionAvailability{Action: ActionMerge, Blocked: &Blocked{Code: code, Message: message, Next: next}}
	}

	switch {
	case pr.Empty:
		return blocked(ActionAlreadyUpToDate, "Already up to date with the target branch — merging would be empty.", "")
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
		return blocked(ActionChecksPending, "Waiting for CI to finish", "Merge unlocks automatically")
	case pr.Behind && pr.MergeStatus != MergeMergeable:
		return blocked(ActionBehind, "Behind the base branch", "Bring it up to date to unlock Merge")
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
func updateBranchAvailability(pr PullRequest) (ActionAvailability, bool) {
	if !pr.Behind || pr.Empty {
		return ActionAvailability{}, false
	}
	if (isDependabotPR(pr) || isRenovatePR(pr)) && !isReleasePleasePR(pr) {
		return ActionAvailability{}, false
	}
	if pr.MergeStatus == MergeConflicting {
		return ActionAvailability{Action: ActionUpdateBranch, Blocked: &Blocked{
			Code:    ActionConflict,
			Message: "Conflicts need fixing by hand — resolve them on the forge.",
		}}, true
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
