package api

import (
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handleReleaseDetails serves one published release's title and notes, for the
// Main branches page's release dialog. A GET that fetches on demand and writes
// nothing, never part of the snapshot.
func handleReleaseDetails(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag := r.URL.Query().Get("tag")
		if tag == "" {
			writeJSON(w, http.StatusBadRequest, errorBody("tag is required"))

			return
		}
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
		detailer, serr := capabilityFor[dashboard.ReleaseDetailer](src, forge, "doesn't support reading releases")
		if serr != nil {
			serr.write(w)

			return
		}

		details, err := detailer.GetReleaseDetails(r.Context(), owner, name, tag)
		if err != nil {
			slog.Warn("release details fetch failed", "forge", forge, "repo", fullName, "tag", tag, "error", err)
			(&statusError{clientErrorStatus(err), err.Error()}).write(w)

			return
		}

		writeJSON(w, http.StatusOK, details)
	}
}
