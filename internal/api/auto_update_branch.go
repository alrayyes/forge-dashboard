package api

import (
	"encoding/json"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// handleAutoUpdateBranchEnable implements POST
// /api/repos/auto-update-branch/enable: a pure local write to
// settings.Store, never touching the forge itself (#365) — same shape
// as handleRepoIgnore. Idempotent, so a repeat call is a 204, not an
// error.
func handleAutoUpdateBranchEnable(deps Deps) http.HandlerFunc {
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

		if err := deps.SettingsStore.EnableAutoUpdateBranch(r.Context(), u.ID, req.Forge, req.FullName); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleAutoUpdateBranchDisable implements POST
// /api/repos/auto-update-branch/disable — the reverse of
// handleAutoUpdateBranchEnable, same request shape, same idempotence.
func handleAutoUpdateBranchDisable(deps Deps) http.HandlerFunc {
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

		if err := deps.SettingsStore.DisableAutoUpdateBranch(r.Context(), u.ID, req.Forge, req.FullName); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
