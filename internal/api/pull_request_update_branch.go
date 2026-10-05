package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestUpdateBranch merges the named pull request's base
// branch into its own head branch — dashboard.BranchUpdater's own
// UpdateBranch decides how, per forge, and whether the forge finished it
// inline or only scheduled it. Follows the same shape
// handlePullRequestMerge already established.
func handlePullRequestUpdateBranch(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(w, deps, t.user.ID, dashboard.ActionUpdateBranch, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		updater, ok := capabilityOf[dashboard.BranchUpdater](w, src, t.req.Forge, "doesn't support updating pull request branches")
		if !ok {
			return
		}

		accepted, err := updater.UpdateBranch(r.Context(), t.owner, t.name, t.req.Number)
		if err != nil {
			slog.Warn("pull request branch update failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, updater, dashboard.PullRequestActionUpdateBranch, t.owner, t.name, t.req.Number, err)

			return
		}

		// Accepted or done inline, the pull request carries the request until
		// a snapshot shows it no longer behind (#982).
		deps.Manager.RecordUpdateRequest(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)

		if accepted {
			w.WriteHeader(http.StatusAccepted)

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
