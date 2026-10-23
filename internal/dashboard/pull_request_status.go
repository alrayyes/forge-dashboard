package dashboard

// PullRequestStatus is the one reason a pull request is waiting on something or
// can't be merged, for the dedicated place on its row (#1375). It is nil when
// nothing holds the pull request back.
//
// A pull request that waiting or fixing can unlock carries Merge's blocked
// reason. An empty one has no Merge to carry it, since nothing can unlock it, so
// the reason is stated here and Close is the way out.
func PullRequestStatus(pr PullRequest, actions []ActionAvailability) *Status {
	if pr.Empty {
		return &Status{
			Code:    ActionAlreadyUpToDate,
			Message: "Nothing to merge: the branch is already on the target branch.",
			Next:    "Close it. There is nothing left to land.",
		}
	}
	for _, a := range actions {
		if a.Action == ActionMerge && a.Blocked != nil {
			return &Status{Blocked: *a.Blocked, Action: fixFor(*a.Blocked, actions)}
		}
	}

	return nil
}

// Status is Merge's blocked reason as the row's status line shows it, plus the
// action that clears it when there is one. Action is only set for a behind
// pull request, where it is the action markPrimary picked: Update branch, or
// the bot's own rebase. A conflict, a pending check or a draft has none, and a
// rebase already waiting leaves none too, since the row then shows that action
// locked.
//
// A behind bot pull request that is waiting on checks has a primary rebase
// from markPrimary but no Action here, on purpose: fixFor answers only for the
// behind block, and the client draws that rebase on the row instead of in the
// status line, so don't make fixFor return it.
type Status struct {
	Blocked

	Action ActionName `json:"action,omitempty"`
}

func fixFor(b Blocked, actions []ActionAvailability) ActionName {
	if b.Code != ActionBehind {
		return ""
	}
	for _, a := range actions {
		if a.Primary && (a.Action == ActionUpdateBranch || a.Action == ActionRenovateRebase || a.Action == ActionDependabotRebase) {
			return a.Action
		}
	}

	return ""
}
