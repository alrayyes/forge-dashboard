package api

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
)

// handleRepoSetting is the shape of the endpoints that take a repo and change
// one local setting for it: read the caller and the body, check the repo name,
// call apply, answer 204. None of them touches the forge, and each is
// idempotent, so a repeat call is a 204 and not an error.
func handleRepoSetting(deps Deps, apply func(ctx context.Context, store *settings.Store, userID []byte, forge, fullName string) error) http.HandlerFunc {
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
		if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
			return
		}
		if _, _, ok := splitFullName(req.FullName); !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		if err := apply(r.Context(), deps.SettingsStore, u.ID, req.Forge, req.FullName); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not save"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
