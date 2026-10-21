package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestClose closes the named pull request without merging
// it — dashboard.PullRequestCloser's own ClosePullRequest decides how,
// per forge. Follows the same shape handlePullRequestMerge already
// established.
func handlePullRequestClose(deps Deps) http.HandlerFunc {
	return handleStateAction(deps, stateAction[dashboard.PullRequestCloser]{
		action:      dashboard.PullRequestActionClose,
		unsupported: "doesn't support closing pull requests",
		logMessage:  "pull request close failed",
		call: func(ctx context.Context, c dashboard.PullRequestCloser, owner, name string, number int) error {
			return c.ClosePullRequest(ctx, owner, name, number)
		},
		settle: func(deps Deps, t actionTarget) {
			deps.Manager.MarkSettled(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)
		},
	})
}
