package api

import (
	"context"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestAutoMerge arms the named pull request's own native
// auto-merge — dashboard.PullRequestAutoMerger's own EnableAutoMerge
// decides how, per forge.
func handlePullRequestAutoMerge(deps Deps) http.HandlerFunc {
	return handleGuardedAction(deps, guardedAction[dashboard.PullRequestAutoMerger]{
		allowed:     dashboard.ActionAutoMerge,
		refusal:     dashboard.PullRequestActionAutoMerge,
		unsupported: "doesn't support enabling auto-merge on pull requests",
		failure:     "pull request auto-merge failed",
		call: func(ctx context.Context, merger dashboard.PullRequestAutoMerger, owner, name string, number int) error {
			return merger.EnableAutoMerge(ctx, owner, name, number)
		},
	})
}
