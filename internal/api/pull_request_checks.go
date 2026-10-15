package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pullRequestChecksResponse matches components.schemas.PullRequestChecksResponse.
type pullRequestChecksResponse struct {
	Checks []dashboard.Check `json:"checks"`
}

// resolvePullRequestChecksFor lists every individual job/check run against the
// named pull request's head commit for u: it resolves which source answers and
// has dashboard.PullRequestChecker do the per-forge fetch. Shared by
// handlePullRequestChecks and the MCP get_pull_request_checks tool so the two
// can't drift. The *statusError carries the HTTP status the handler answers
// with.
func resolvePullRequestChecksFor(ctx context.Context, deps Deps, u *auth.User, forge, fullName string, number int) ([]dashboard.Check, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return nil, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, u.ID, forge)
	if serr != nil {
		return nil, serr
	}
	checker, serr := capabilityFor[dashboard.PullRequestChecker](src, forge, "doesn't support listing pull request checks")
	if serr != nil {
		return nil, serr
	}

	checks, err := checker.ListChecks(ctx, owner, name, number)
	if err != nil {
		slog.Warn("pull request checks fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)

		return nil, &statusError{clientErrorStatus(err), err.Error()}
	}

	return checks, nil
}

// handlePullRequestChecks serves resolvePullRequestChecksFor over HTTP. A GET,
// unlike every other pull-request endpoint here: it fetches on demand rather
// than writing anything, so its parameters are a query string, not a JSON body,
// the same shape GET /api/dashboard's own owner parameter already uses.
func handlePullRequestChecks(deps Deps) http.HandlerFunc {
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

		checks, serr := resolvePullRequestChecksFor(r.Context(), deps, u, r.URL.Query().Get("forge"), r.URL.Query().Get("fullName"), number)
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, pullRequestChecksResponse{Checks: checks})
	}
}
