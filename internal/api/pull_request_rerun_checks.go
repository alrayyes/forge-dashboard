package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestRerunChecks asks the forge to rerun the failed jobs of the
// named pull request's checks (#698) — dashboard.ChecksRerunner's own
// RerunFailedChecks decides how. It answers once the forge has queued them.
func handlePullRequestRerunChecks(deps Deps) http.HandlerFunc {
	return handleGuardedAction(deps, guardedAction[dashboard.ChecksRerunner]{
		allowed:     dashboard.ActionRerunChecks,
		refusal:     dashboard.PullRequestActionRerunChecks,
		unsupported: "doesn't support rerunning checks",
		failure:     "pull request checks rerun failed",
		call: func(ctx context.Context, rerunner dashboard.ChecksRerunner, owner, name string, number int) error {
			return rerunner.RerunFailedChecks(ctx, owner, name, number)
		},
	})
}
