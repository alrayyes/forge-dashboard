package api

import (
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

// handlePullRequestChecks lists every individual job/check run against
// the named pull request's head commit — dashboard.PullRequestChecker
// does the actual per-forge fetch; this handler only resolves which
// source answers it. A GET, unlike every other pull-request endpoint
// here: it fetches on demand rather than writing anything, so its
// parameters are a query string, not a JSON body, the same shape
// GET /api/dashboard's own owner parameter already uses.
func handlePullRequestChecks(deps Deps) http.HandlerFunc {
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
		checker, ok := capabilityOf[dashboard.PullRequestChecker](w, src, forge, "doesn't support listing pull request checks")
		if !ok {
			return
		}

		checks, err := checker.ListChecks(r.Context(), owner, name, number)
		if err != nil {
			slog.Warn("pull request checks fetch failed", "forge", forge, "repo", fullName, "number", number, "error", err)
			writeJSON(w, clientErrorStatus(err), errorBody(err.Error()))

			return
		}

		writeJSON(w, http.StatusOK, pullRequestChecksResponse{Checks: checks})
	}
}
