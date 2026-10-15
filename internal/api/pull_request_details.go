package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// resolvePullRequestDetailsFor reads one pull request's description, comments
// and reactions for u (#1506): it resolves which source answers, has
// dashboard.PullRequestDetailer do the per-forge fetch, and adds the release
// notes for a release pull request. Shared by handlePullRequestDetails and the
// MCP get_pull_request_details tool so the two can't drift. The *statusError
// carries the HTTP status the handler answers with.
func resolvePullRequestDetailsFor(ctx context.Context, deps Deps, u *auth.User, forge, fullName string, number int) (dashboard.PullRequestDetails, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return dashboard.PullRequestDetails{}, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, u.ID, forge)
	if serr != nil {
		return dashboard.PullRequestDetails{}, serr
	}
	detailer, serr := capabilityFor[dashboard.PullRequestDetailer](src, forge, "doesn't support reading pull request details")
	if serr != nil {
		return dashboard.PullRequestDetails{}, serr
	}

	details, err := detailer.GetPullRequestDetails(ctx, owner, name, number)
	if err != nil {
		slog.Warn("pull request details fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)

		return dashboard.PullRequestDetails{}, &statusError{clientErrorStatus(err), err.Error()}
	}

	details.ReleaseNotes = releaseNotesOf(deps, u.ID, dashboard.Forge(forge), fullName, number, details.Description)

	return details, nil
}

// handlePullRequestDetails serves resolvePullRequestDetailsFor over HTTP. A GET
// like the checks endpoint: it fetches on demand and writes nothing, so it takes
// a query string, and it is never part of the snapshot, so a thread nobody opens
// costs no budget.
func handlePullRequestDetails(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		number, err := strconv.Atoi(r.URL.Query().Get("number"))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("number must be an integer"))

			return
		}

		details, serr := resolvePullRequestDetailsFor(r.Context(), deps, u, r.URL.Query().Get("forge"), r.URL.Query().Get("fullName"), number)
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, details)
	}
}

// releaseNotesOf is the description again when the board holds the pull request
// as a release one: a release-please pull request's description is the
// changelog it publishes. Nil for any other kind, for an empty description, and for a pull
// request the board doesn't list, since the kind is the board's rule and not worth a second
// copy here.
func releaseNotesOf(deps Deps, userID []byte, forge dashboard.Forge, fullName string, number int, description dashboard.DetailsBody) *dashboard.DetailsBody {
	pr, found := deps.Manager.FindPullRequest(userID, forge, fullName, number)
	if !found || dashboard.KindOf(pr, nil) != dashboard.KindRelease || description.Text == "" {
		return nil
	}
	notes := description

	return &notes
}
