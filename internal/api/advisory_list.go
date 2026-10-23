package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handleAdvisoryList serves one repo's open dependency advisories in full, for
// the advisories dialog on the Main branches page. A GET that reads the forge on
// demand and writes nothing, never part of the snapshot. A forge that can't say
// (alerts off, no permission, rate limited) is a 200 with state unknown and the
// reason, the same way the row's own advisories are, not an error.
func handleAdvisoryList(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		forge, fullName := r.URL.Query().Get("forge"), r.URL.Query().Get("fullName")
		owner, name, ok := splitFullName(fullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		src, _, serr := lookupForgeSource(r.Context(), deps, forge)
		if serr != nil {
			serr.write(w)

			return
		}
		lister, serr := capabilityFor[dashboard.AdvisoryLister](src, forge, "doesn't support listing advisories")
		if serr != nil {
			serr.write(w)

			return
		}

		list, err := lister.ListAdvisories(r.Context(), owner, name)
		if err != nil {
			slog.Warn("advisory list fetch failed", "forge", forge, "repo", fullName, "error", err)
			(&statusError{clientErrorStatus(err), err.Error()}).write(w)

			return
		}

		writeJSON(w, http.StatusOK, list)
	}
}
