package api

import (
	"context"
	"log/slog"
	"net/http"
	"slices"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// resolveMainBranchChecksFor lists every job/check of the newest pipeline on the
// named repository's default branch for u. It is the branch twin of
// resolvePullRequestChecksFor and shares its response shape, so the pipeline
// panel that renders one renders the other. Shared by handleMainBranchChecks
// and the MCP get_main_branch_checks tool so the two can't drift.
func resolveMainBranchChecksFor(ctx context.Context, deps Deps, forge, fullName string) ([]dashboard.Check, *statusError) {
	owner, name, ok := splitFullName(fullName)
	if !ok {
		return nil, &statusError{http.StatusBadRequest, `fullName must be "owner/repo"`}
	}

	src, _, serr := lookupForgeSource(ctx, deps, forge)
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
		checks, serr := resolveMainBranchChecksFor(r.Context(), deps, r.URL.Query().Get("forge"), r.URL.Query().Get("fullName"))
		if serr != nil {
			serr.write(w)

			return
		}

		writeJSON(w, http.StatusOK, pullRequestChecksResponse{Checks: checks})
	}
}

// trackedMainBranch finds fullName's row among the ones the user's Main
// branches page shows, so the rerun route can't be aimed at a repository the
// dashboard doesn't follow. The row also names the default branch, which saves
// the forge a lookup.
func trackedMainBranch(ctx context.Context, deps Deps, forge, fullName string) (mainBranchView, bool) {
	rows := resolveMainBranchesFor(ctx, deps).Branches
	i := slices.IndexFunc(rows, func(b mainBranchView) bool {
		return string(b.Forge) == forge && b.FullName == fullName
	})
	if i < 0 {
		return mainBranchView{}, false
	}

	return rows[i], true
}

// handleMainBranchRerunChecks asks the forge to rerun the failed jobs of the
// newest pipeline on the named repository's default branch: the branch twin of
// handlePullRequestRerunChecks. It answers 204 once the forge has queued them.
func handleMainBranchRerunChecks(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		req := t.req
		owner, name := t.owner, t.name

		src, _, ok := forgeSource(w, r, deps, req.Forge)
		if !ok {
			return
		}
		rerunner, ok := capabilityOf[dashboard.DefaultBranchRerunner](w, src, req.Forge, "doesn't support rerunning default branch checks")
		if !ok {
			return
		}

		row, tracked := trackedMainBranch(r.Context(), deps, req.Forge, req.FullName)
		if !tracked {
			writeJSON(w, http.StatusNotFound, errorBody("that repository's default branch isn't tracked"))

			return
		}

		if err := rerunner.RerunFailedDefaultBranchChecks(r.Context(), owner, name, row.Branch); err != nil {
			slog.Warn("default branch checks rerun failed", "forge", req.Forge, "repo", req.FullName, "error", err)
			writeActionRefusal(r.Context(), w, nil, dashboard.PullRequestActionRerunBranchChecks, owner, name, 0, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
