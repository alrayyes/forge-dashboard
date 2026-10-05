package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pullRequestActionRequest matches components.schemas.PullRequestActionRequest.
type pullRequestActionRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number"`
}

// handlePullRequestMerge merges the named pull request using its repo's
// own configured default merge method — dashboard.PullRequestMerger's own
// MergePullRequest decides how, per forge. Follows the same shape
// handleWebhookEnsure already established for a write to a forge.
func handlePullRequestMerge(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(w, deps, t.user.ID, dashboard.ActionMerge, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		merger, ok := capabilityOf[dashboard.PullRequestMerger](w, src, t.req.Forge, "doesn't support merging pull requests")
		if !ok {
			return
		}

		if err := merger.MergePullRequest(r.Context(), t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("pull request merge failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, merger, dashboard.PullRequestActionMerge, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Manager.MarkSettled(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)
		w.WriteHeader(http.StatusNoContent)
	}
}
