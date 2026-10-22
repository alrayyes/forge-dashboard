package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handleIssueDetails serves one issue's description, comments and reactions,
// the sibling of handlePullRequestDetails. A GET that fetches on demand and
// writes nothing, never part of the snapshot, so a thread nobody opens costs
// no budget.
func handleIssueDetails(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		number, err := strconv.Atoi(r.URL.Query().Get("number"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("number must be an integer"))

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
		detailer, serr := capabilityFor[dashboard.IssueDetailer](src, forge, "doesn't support reading issue details")
		if serr != nil {
			serr.write(w)

			return
		}

		details, err := detailer.GetIssueDetails(r.Context(), owner, name, number)
		if err != nil {
			slog.Warn("issue details fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)
			(&statusError{clientErrorStatus(err), err.Error()}).write(w)

			return
		}

		linkCommenters(details.Comments, dashboard.Forge(forge), boardWebBase(deps, dashboard.Forge(forge), fullName))
		writeJSON(w, http.StatusOK, details)
	}
}
