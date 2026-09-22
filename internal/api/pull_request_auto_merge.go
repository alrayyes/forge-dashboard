package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestAutoMerge arms the named pull request's own native
// auto-merge — dashboard.PullRequestAutoMerger's own EnableAutoMerge
// decides how, per forge. Follows the same shape handlePullRequestMerge
// already established.
func handlePullRequestAutoMerge(deps Deps) http.HandlerFunc {
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

		var merger dashboard.PullRequestAutoMerger
		for _, src := range deps.BuildSources(u.ID, creds) {
			if string(src.Forge()) != req.Forge {
				continue
			}
			m, supported := src.(dashboard.PullRequestAutoMerger)
			if !supported {
				writeJSON(w, http.StatusBadRequest, errorBody(req.Forge+" doesn't support enabling auto-merge on pull requests"))

				return
			}
			merger = m

			break
		}
		if merger == nil {
			writeJSON(w, http.StatusBadRequest, errorBody("no "+req.Forge+" credentials saved"))

			return
		}

		if err := merger.EnableAutoMerge(r.Context(), owner, name, req.Number); err != nil {
			slog.Warn("pull request auto-merge failed", "forge", req.Forge, "repo", req.FullName, "number", req.Number, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
