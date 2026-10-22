package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// resolveMainBranchChecksFor lists every job/check of the newest pipeline on the
// named repository's default branch for u. It is the branch twin of
// resolvePullRequestChecksFor and shares its response shape, so the pipeline
// panel that renders one renders the other. Shared by handleMainBranchChecks
// and the MCP get_main_branch_checks tool so the two can't drift.
func resolveMainBranchChecksFor(ctx context.Context, deps Deps, u *auth.User, forge, fullName string) ([]dashboard.Check, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return nil, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, u.ID, forge)
	if serr != nil {
		return nil, serr
	}
	checker, serr := capabilityFor[dashboard.DefaultBranchChecker](src, forge, "doesn't support listing default branch checks")
	if serr != nil {
		return nil, serr
	}

	checks, err := checker.ListDefaultBranchChecks(ctx, owner, name)
	if err != nil {
		slog.Warn("default branch checks fetch failed", "forge", forge, "repo", fullName, "error", err)

		return nil, &statusError{clientErrorStatus(err), err.Error()}
	}
	if checks == nil {
		checks = []dashboard.Check{}
	}

	return checks, nil
}

// handleMainBranchChecks serves resolveMainBranchChecksFor over HTTP. A GET that
// fetches on demand, like GET /api/pull-requests/checks: the job list is never
// part of the dashboard snapshot.
func handleMainBranchChecks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		checks, serr := resolveMainBranchChecksFor(r.Context(), deps, u, r.URL.Query().Get("forge"), r.URL.Query().Get("fullName"))
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, pullRequestChecksResponse{Checks: checks})
	}
}

// mainBranchRerunRequest names the repository whose default branch to rerun.
type mainBranchRerunRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
}

// handleMainBranchRerunChecks asks the forge to rerun the failed jobs of the
// newest pipeline on the named repository's default branch: the branch twin of
// handlePullRequestRerunChecks. It answers 204 once the forge has queued them.
func handleMainBranchRerunChecks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req mainBranchRerunRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}
		if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
			return
		}
		owner, name, ok := splitFullName(req.FullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		src, _, ok := forgeSource(w, r, deps, u.ID, req.Forge)
		if !ok {
			return
		}
		rerunner, ok := capabilityOf[dashboard.DefaultBranchRerunner](w, src, req.Forge, "doesn't support rerunning default branch checks")
		if !ok {
			return
		}

		if err := rerunner.RerunFailedDefaultBranchChecks(r.Context(), owner, name); err != nil {
			slog.Warn("default branch checks rerun failed", "forge", req.Forge, "repo", req.FullName, "error", err)
			writeActionRefusal(r.Context(), w, nil, dashboard.PullRequestActionRerunChecks, owner, name, 0, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
