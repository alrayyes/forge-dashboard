package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestUpdateBranch merges the named pull request's base
// branch into its own head branch — dashboard.BranchUpdater's own
// UpdateBranch decides how, per forge, and whether the forge finished it
// inline or only scheduled it. Follows the same shape
// handlePullRequestMerge already established.
func handlePullRequestUpdateBranch(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req pullRequestActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		owner, name, ok := splitFullName(req.FullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		var updater dashboard.BranchUpdater
		for _, src := range deps.BuildSources(creds) {
			if string(src.Forge()) != req.Forge {
				continue
			}
			b, supported := src.(dashboard.BranchUpdater)
			if !supported {
				writeJSON(w, http.StatusBadRequest, errorBody(req.Forge+" doesn't support updating pull request branches"))

				return
			}
			updater = b

			break
		}
		if updater == nil {
			writeJSON(w, http.StatusBadRequest, errorBody("no "+req.Forge+" credentials saved"))

			return
		}

		accepted, err := updater.UpdateBranch(r.Context(), owner, name, req.Number)
		if err != nil {
			slog.Warn("pull request branch update failed", "forge", req.Forge, "repo", req.FullName, "number", req.Number, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))

			return
		}

		if accepted {
			w.WriteHeader(http.StatusAccepted)

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
