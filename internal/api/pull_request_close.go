package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestClose closes the named pull request without merging
// it — dashboard.PullRequestCloser's own ClosePullRequest decides how,
// per forge. Follows the same shape handlePullRequestMerge already
// established.
func handlePullRequestClose(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		closer, ok := capabilityOf[dashboard.PullRequestCloser](w, src, t.req.Forge, "doesn't support closing pull requests")
		if !ok {
			return
		}

		if err := closer.ClosePullRequest(r.Context(), t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("pull request close failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, closer, dashboard.PullRequestActionClose, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Manager.MarkSettled(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)
		w.WriteHeader(http.StatusNoContent)
	}
}
