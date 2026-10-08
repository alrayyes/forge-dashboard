package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestRenovateRebase adds the signed-in user's own configured
// Renovate rebase label (settings.Credentials.RenovateRebaseLabelOrDefault
// — genuinely per-repo configurable on Renovate's own side, but this app
// only knows the one label a user saved) to the named pull request —
// Renovate's own rebase/retry trigger, on both forges. Follows the same
// shape handlePullRequestUpdateBranch already established.
func handlePullRequestRenovateRebase(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(r.Context(), w, deps, t.user.ID, dashboard.ActionRenovateRebase, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, creds, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		labeler, ok := capabilityOf[dashboard.PullRequestLabeler](w, src, t.req.Forge, "doesn't support labeling pull requests")
		if !ok {
			return
		}

		label := creds.RenovateRebaseLabelOrDefault()
		if err := labeler.AddLabel(r.Context(), t.owner, t.name, t.req.Number, label); err != nil {
			slog.Warn("renovate rebase label failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "label", label, "error", err)
			writeActionRefusal(r.Context(), w, labeler, dashboard.PullRequestActionRenovateRebase, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Manager.RecordBotRequest(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number, dashboard.BotRenovate, dashboard.BotRebase)

		w.WriteHeader(http.StatusNoContent)
	}
}
