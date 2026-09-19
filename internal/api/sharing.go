package api

import (
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// SharedUser matches components.schemas.SharedUser in api/openapi.yaml.
type SharedUser struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}

// SharingResponse matches components.schemas.SharingResponse.
type SharingResponse struct {
	SharedWith   []SharedUser `json:"sharedWith"`
	SharedWithMe []SharedUser `json:"sharedWithMe"`
}

func handleSharingGet(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		sharedWithIDs, err := deps.SharingStore.SharedWith(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load sharing"))

			return
		}
		sharedWithMeIDs, err := deps.SharingStore.SharedWithMe(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load sharing"))

			return
		}

		sharedWith, err := resolveSharedUsers(r, deps, sharedWithIDs)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not resolve shared users"))

			return
		}
		sharedWithMe, err := resolveSharedUsers(r, deps, sharedWithMeIDs)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not resolve shared users"))

			return
		}

		writeJSON(w, http.StatusOK, SharingResponse{SharedWith: sharedWith, SharedWithMe: sharedWithMe})
	}
}

// resolveSharedUsers turns raw user IDs from sharing.Store into the
// username/displayName pairs the frontend actually wants — sharing
// itself only ever deals in IDs.
func resolveSharedUsers(r *http.Request, deps Deps, ids [][]byte) ([]SharedUser, error) {
	out := make([]SharedUser, 0, len(ids))
	for _, id := range ids {
		u, err := deps.AuthStore.GetUserByID(r.Context(), id)
		if err != nil {
			return nil, err
		}
		out = append(out, SharedUser{Username: u.Username, DisplayName: u.DisplayName})
	}

	return out, nil
}

func handleSharingPut(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		username := r.PathValue("username")
		if username == u.Username {
			writeJSON(w, http.StatusBadRequest, errorBody("can't share your dashboard with yourself"))

			return
		}

		target, err := deps.AuthStore.GetUserByUsername(r.Context(), username)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no user is registered under that username"))

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up user"))

			return
		}

		if err := deps.SharingStore.Share(r.Context(), u.ID, target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not share"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleSharingDelete(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		username := r.PathValue("username")
		target, err := deps.AuthStore.GetUserByUsername(r.Context(), username)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				// Idempotent: nothing to unshare from a username that
				// was never shared with in the first place, registered
				// or not.
				w.WriteHeader(http.StatusNoContent)

				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up user"))

			return
		}

		if err := deps.SharingStore.Unshare(r.Context(), u.ID, target.ID); err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not unshare"))

			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
