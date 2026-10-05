package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestAutoMerge arms the named pull request's own native
// auto-merge — dashboard.PullRequestAutoMerger's own EnableAutoMerge
// decides how, per forge. Follows the same shape handlePullRequestMerge
// already established.
func handlePullRequestAutoMerge(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(w, deps, t.user.ID, dashboard.ActionAutoMerge, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		merger, ok := capabilityOf[dashboard.PullRequestAutoMerger](w, src, t.req.Forge, "doesn't support enabling auto-merge on pull requests")
		if !ok {
			return
		}

		if err := merger.EnableAutoMerge(r.Context(), t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("pull request auto-merge failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, merger, dashboard.PullRequestActionAutoMerge, t.owner, t.name, t.req.Number, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
