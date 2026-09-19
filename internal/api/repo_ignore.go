package api

import (
	"encoding/json"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// repoActionRequest matches components.schemas.WebhookEnsureRequest, reused
// as-is for both ignore/unignore: the body shape is identical (which repo,
// on which forge).
type repoActionRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
}

// handleRepoIgnore implements POST /api/repos/ignore: a pure local write
// to settings.Store, never touching the forge itself (#363) — the repo
// keeps being fetched and tracked, only its pullRequests/issues entries
// stop appearing in buildDashboardResponse. Idempotent, so a repeat call
// (a double click, a retried request) is a 204, not an error.
func handleRepoIgnore(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req repoActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if _, _, ok := splitFullName(req.FullName); !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		if err := deps.SettingsStore.IgnoreRepo(r.Context(), u.ID, req.Forge, req.FullName); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleRepoUnignore implements POST /api/repos/unignore — the reverse of
// handleRepoIgnore, same request shape, same idempotence.
func handleRepoUnignore(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req repoActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if _, _, ok := splitFullName(req.FullName); !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		if err := deps.SettingsStore.UnignoreRepo(r.Context(), u.ID, req.Forge, req.FullName); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
