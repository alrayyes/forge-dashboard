package dashboard

import (
	"slices"
	"strings"
)

// IsReadyToMerge is the Ready quick filter (#807): mergeable, CI green and not
// a draft. Not readyToMerge in aggregator.go, which only orders the list and
// lets a pull request with no checks float up too.
func IsReadyToMerge(pr PullRequest) bool {
	return pr.MergeStatus == MergeMergeable && pr.CI == CISuccess && !pr.Draft
}

// NeedsReview is the Needs review quick filter (#807): a review is
// outstanding, meaning the forge requires one or a reviewer was asked. An
// unreviewed pull request nobody was asked about is merely unreviewed,
// approved and changes requested aren't waiting on a reviewer, and an
// unknown review state (no review object) isn't the same as nobody having
// reviewed. A draft never needs review.
func NeedsReview(pr PullRequest) bool {
	if pr.Draft || pr.Review == nil {
		return false
	}

	return pr.Review.Decision == ReviewRequired ||
		(pr.Review.Decision == ReviewNone && pr.Review.RequestedReviewers > 0)
}

// ReviewRequestedFrom is "review requested from me" (#695): an open,
// non-draft pull request that asks login to review. Logins match without
// regard to case, since a forge treats them that way. An empty login matches
// nothing.
func ReviewRequestedFrom(pr PullRequest, login string) bool {
	if pr.Draft || login == "" {
		return false
	}

	return slices.ContainsFunc(pr.RequestedReviewerLogins, func(l string) bool {
		return strings.EqualFold(l, login)
	})
}
