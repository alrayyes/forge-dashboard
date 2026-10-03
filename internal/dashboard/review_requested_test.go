package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// "Review requested from me" (#695): an open, non-draft pull request that
// asks this login to review.
func TestReviewRequestedFrom(t *testing.T) {
	t.Parallel()

	pr := func(draft bool, logins ...string) dashboard.PullRequest {
		return dashboard.PullRequest{Draft: draft, RequestedReviewerLogins: logins}
	}
	cases := []struct {
		name  string
		pr    dashboard.PullRequest
		login string
		want  bool
	}{
		{"asked to review", pr(false, "bob", "ryan"), "ryan", true},
		{"asked, but a different case of the same login", pr(false, "Ryan"), "ryan", true},
		{"others were asked, not me", pr(false, "bob"), "ryan", false},
		{"nobody was asked", pr(false), "ryan", false},
		{"a draft never counts", pr(true, "ryan"), "ryan", false},
		{"no login to match", pr(false, "ryan"), "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, tc.want, dashboard.ReviewRequestedFrom(tc.pr, tc.login))
		})
	}
}
