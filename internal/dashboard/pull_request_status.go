package dashboard

// PullRequestStatus is the one reason a pull request is waiting on something or
// can't be merged, for the dedicated place on its row (#1375). It is nil when
// nothing holds the pull request back.
//
// A pull request that waiting or fixing can unlock carries Merge's blocked
// reason. An empty one has no Merge to carry it, since nothing can unlock it, so
// the reason is stated here and Close is the way out.
func PullRequestStatus(pr PullRequest, actions []ActionAvailability) *Blocked {
	if pr.Empty {
		return &Blocked{
			Code:    ActionAlreadyUpToDate,
			Message: "Nothing to merge: the branch is already on the target branch.",
			Next:    "Close it. There is nothing left to land.",
		}
	}
	for _, a := range actions {
		if a.Action == ActionMerge && a.Blocked != nil {
			blocked := *a.Blocked

			return &blocked
		}
	}

	return nil
}
