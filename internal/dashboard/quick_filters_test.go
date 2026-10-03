package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func review(decision dashboard.ReviewDecision, requested int) *dashboard.ReviewState {
	return &dashboard.ReviewState{Decision: decision, RequestedReviewers: requested}
}

// Ready and Needs review, as the page's quick filters defined them (#807).
func TestReadyAndNeedsReview(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		pr         dashboard.PullRequest
		ready      bool
		needsReady bool
	}{
		{"mergeable, CI green, not a draft is ready", dashboard.PullRequest{MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess}, true, false},
		{"a draft is never ready", dashboard.PullRequest{MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess, Draft: true}, false, false},
		{"CI pending is not ready", dashboard.PullRequest{MergeStatus: dashboard.MergeMergeable, CI: dashboard.CIPending}, false, false},
		{"no checks is not ready", dashboard.PullRequest{MergeStatus: dashboard.MergeMergeable, CI: dashboard.CINone}, false, false},
		{"CI failing is not ready", dashboard.PullRequest{MergeStatus: dashboard.MergeMergeable, CI: dashboard.CIFailure}, false, false},
		{"blocked is not ready", dashboard.PullRequest{MergeStatus: dashboard.MergeBlocked, CI: dashboard.CISuccess}, false, false},
		{"a review the forge requires needs review", dashboard.PullRequest{Review: review(dashboard.ReviewRequired, 0)}, false, true},
		{"unreviewed with a reviewer asked needs review", dashboard.PullRequest{Review: review(dashboard.ReviewNone, 2)}, false, true},
		{"unreviewed with nobody asked is not waiting", dashboard.PullRequest{Review: review(dashboard.ReviewNone, 0)}, false, false},
		{"approved is not waiting on a reviewer", dashboard.PullRequest{Review: review(dashboard.ReviewApproved, 1)}, false, false},
		{"changes requested is not waiting on a reviewer", dashboard.PullRequest{Review: review(dashboard.ReviewChangesRequested, 1)}, false, false},
		{"unknown review state is not needs review", dashboard.PullRequest{}, false, false},
		{"a draft never needs review", dashboard.PullRequest{Draft: true, Review: review(dashboard.ReviewRequired, 1)}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.ready, dashboard.IsReadyToMerge(tc.pr), "ready")
			assert.Equal(t, tc.needsReady, dashboard.NeedsReview(tc.pr), "needs review")
		})
	}
}
