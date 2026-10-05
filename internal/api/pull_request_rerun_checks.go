package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestRerunChecks asks the forge to rerun the failed jobs of the
// named pull request's checks (#698) — dashboard.ChecksRerunner's own
// RerunFailedChecks decides how. It answers once the forge has queued them.
// Follows the same shape handlePullRequestUpdateBranch established.
func handlePullRequestRerunChecks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(w, deps, t.user.ID, dashboard.ActionRerunChecks, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		rerunner, ok := capabilityOf[dashboard.ChecksRerunner](w, src, t.req.Forge, "doesn't support rerunning checks")
		if !ok {
			return
		}

		if err := rerunner.RerunFailedChecks(r.Context(), t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("pull request checks rerun failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, rerunner, dashboard.PullRequestActionRerunChecks, t.owner, t.name, t.req.Number, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
