package api

import (
	"encoding/json"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// repoActionRequest matches components.schemas.WebhookEnsureRequest, reused
// as-is for the webhook-ensure, unignore and auto-update-branch endpoints:
// the body shape is identical (which repo, on which forge).
type repoActionRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
}

// repoIgnoreRequest matches components.schemas.RepoIgnoreRequest (#511) —
// repoActionRequest plus which scope(s) to ignore.
type repoIgnoreRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	PRs      bool   `json:"prs"`
	Issues   bool   `json:"issues"`
}

// handleRepoIgnore implements POST /api/repos/ignore: a pure local write
// to settings.Store, never touching the forge itself (#363) — the repo
// keeps being fetched and tracked, only the pullRequests/issues entries
// the request scopes (#511) stop appearing in buildDashboardResponse. A
// repeat call with the same scope is a 204, not an error; a repeat call
// with a different scope replaces it rather than merging.
func handleRepoIgnore(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req repoIgnoreRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if _, _, ok := splitFullName(req.FullName); !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}
		if !req.PRs && !req.Issues {
			writeJSON(w, http.StatusBadRequest, errorBody("at least one of prs or issues must be true"))

			return
		}

		if err := deps.SettingsStore.IgnoreRepo(r.Context(), u.ID, req.Forge, req.FullName, req.PRs, req.Issues); err != nil {
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
