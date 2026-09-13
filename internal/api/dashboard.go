package api

import (
	"errors"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// handleDashboard answers the requested dashboard: the signed-in user's
// own by default, or another user's — passed as ?owner=username — when
// that user has shared their dashboard with the caller. It never blocks
// on either forge: Manager.Get reads whatever that user's background
// refresh last assembled — empty, not an error, for a user who hasn't
// saved any credentials in Settings yet.
func handleDashboard(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			// RequireAuth always sets this before handleDashboard runs;
			// reaching here with none would be a wiring bug, not a
			// request this handler can meaningfully answer.
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}

		ownerUsername := r.URL.Query().Get("owner")
		if ownerUsername == "" || ownerUsername == u.Username {
			writeJSON(w, http.StatusOK, deps.Manager.Get(u.ID))
			return
		}

		owner, err := deps.AuthStore.GetUserByUsername(r.Context(), ownerUsername)
		if err != nil {
			if errors.Is(err, auth.ErrNotFound) {
				writeJSON(w, http.StatusNotFound, errorBody("no user is registered under that username"))
				return
			}
			writeJSON(w, http.StatusInternalServerError, errorBody("could not look up owner"))
			return
		}

		shared, err := deps.SharingStore.IsSharedWith(r.Context(), owner.ID, u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not check sharing"))
			return
		}
		if !shared {
			writeJSON(w, http.StatusForbidden, errorBody("that user hasn't shared their dashboard with you"))
			return
		}

		writeJSON(w, http.StatusOK, deps.Manager.Get(owner.ID))
	}
}
