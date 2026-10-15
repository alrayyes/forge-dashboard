package api

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// handlePullRequestDetails reads one pull request's description, comments and
// reactions for the pull request dialog (#1506). A GET like the checks
// endpoint: it fetches on demand and writes nothing, so it takes a query string,
// and it is never part of the snapshot, so a thread nobody opens costs no
// budget. dashboard.PullRequestDetailer does the per-forge fetch; this resolves
// which source answers, and adds the release notes for a release pull request.
func handlePullRequestDetails(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		forge := r.URL.Query().Get("forge")
		fullName := r.URL.Query().Get("fullName")
		number, err := strconv.Atoi(r.URL.Query().Get("number"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("number must be an integer"))

			return
		}

		owner, name, ok := splitFullName(fullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		src, _, ok := forgeSource(w, r, deps, u.ID, forge)
		if !ok {
			return
		}
		detailer, ok := capabilityOf[dashboard.PullRequestDetailer](w, src, forge, "doesn't support reading pull request details")
		if !ok {
			return
		}

		details, err := detailer.GetPullRequestDetails(r.Context(), owner, name, number)
		if err != nil {
			slog.Warn("pull request details fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))

			return
		}

		details.ReleaseNotes = releaseNotesOf(deps, u.ID, dashboard.Forge(forge), fullName, number, details.Description)
		writeJSON(w, http.StatusOK, details)
	}
}

// releaseNotesOf is the description again when the board holds the pull request
// as a release one: a release-please pull request's description is the
// changelog it publishes. Nil for any other kind, and for a pull request the
// board doesn't list, since the kind is the board's rule and not worth a second
// copy here.
func releaseNotesOf(deps Deps, userID []byte, forge dashboard.Forge, fullName string, number int, description dashboard.DetailsBody) *dashboard.DetailsBody {
	pr, found := deps.Manager.FindPullRequest(userID, forge, fullName, number)
	if !found || dashboard.KindOf(pr, nil) != dashboard.KindRelease {
		return nil
	}
	notes := description

	return &notes
}
