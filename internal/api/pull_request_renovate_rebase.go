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
		if refuseIfNotAllowed(r.Context(), w, deps, dashboard.ActionRenovateRebase, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, creds, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		labeler, ok := capabilityOf[dashboard.PullRequestLabeler](w, src, t.req.Forge, "doesn't support labeling pull requests")
		if !ok {
			return
		}

		label := creds.RenovateRebaseLabelOrDefault()
		outcome, err := dashboard.RequestRenovateRebase(r.Context(), src, labeler, t.owner, t.name, t.req.Number, label)
		if err != nil {
			slog.Warn("renovate rebase request failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "label", label, "error", err)
			writeActionRefusal(r.Context(), w, labeler, dashboard.PullRequestActionRenovateRebase, t.owner, t.name, t.req.Number, err)

			return
		}
		if outcome == dashboard.RenovateRebaseAlreadyRequested {
			const message = "A Renovate rebase is already requested on this pull request."
			writeJSON(w, http.StatusConflict, actionErrorBody{Error: message, Code: string(dashboard.ActionAlreadyRequested), Message: message})

			return
		}

		deps.Service.RecordBotRequest(dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number, dashboard.BotRenovate, dashboard.BotRebase)
		if outcome == dashboard.RenovateRebaseTicked {
			deps.Service.SetRenovateRebaseBox(dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number, true)
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// handlePullRequestRenovateRebaseCancel withdraws a Renovate rebase asked for
// through the description's rebase box, by clearing the box. Only offered while
// the box is ticked; a request made with the label has no way back.
func handlePullRequestRenovateRebaseCancel(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(r.Context(), w, deps, dashboard.ActionCancelRenovateRebase, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		editor, ok := capabilityOf[dashboard.PullRequestBodyEditor](w, src, t.req.Forge, "doesn't support editing pull request descriptions")
		if !ok {
			return
		}

		if err := dashboard.CancelRenovateRebase(r.Context(), editor, t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("renovate rebase cancel failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, src, dashboard.PullRequestActionCancelRenovateRebase, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Service.SetRenovateRebaseBox(dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number, false)

		w.WriteHeader(http.StatusNoContent)
	}
}
