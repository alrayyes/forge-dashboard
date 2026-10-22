package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestReopen reopens a pull request that was closed without
// merging: the undo for handlePullRequestClose. dashboard.PullRequestReopener's
// own ReopenPullRequest decides how, per forge, and the forge decides whether
// it can (a merged pull request, or one whose head branch is gone, is refused).
func handlePullRequestReopen(deps Deps) http.HandlerFunc {
	return handleStateAction(deps, stateAction[dashboard.PullRequestReopener]{
		action:      dashboard.PullRequestActionReopen,
		unsupported: "doesn't support reopening pull requests",
		logMessage:  "pull request reopen failed",
		call: func(ctx context.Context, c dashboard.PullRequestReopener, owner, name string, number int) error {
			return c.ReopenPullRequest(ctx, owner, name, number)
		},
		// The close held the pull request off the board; the next refresh
		// lists it again.
		settle: func(deps Deps, t actionTarget) {
			deps.Service.Unsettle(dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)
		},
	})
}
