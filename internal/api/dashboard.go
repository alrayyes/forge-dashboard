package api

import (
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handleDashboard answers the signed-in user's own snapshot. It never
// blocks on either forge: Manager.Get reads whatever that user's
// background refresh last assembled — empty, not an error, for a user
// who hasn't saved any credentials in Settings yet.
func handleDashboard(manager *dashboard.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			// RequireAuth always sets this before handleDashboard runs;
			// reaching here with none would be a wiring bug, not a
			// request this handler can meaningfully answer.
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))
			return
		}
		writeJSON(w, http.StatusOK, manager.Get(u.ID))
	}
}
