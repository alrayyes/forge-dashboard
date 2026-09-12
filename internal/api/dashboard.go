package api

import (
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handleDashboard answers the current snapshot. It never blocks on either
// forge: getSnapshot reads whatever the background refresh last assembled.
func handleDashboard(getSnapshot func() dashboard.Snapshot) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, getSnapshot())
	}
}
