package api

import (
	"context"
	"log/slog"
	"net/http"
	"slices"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// cancelRunRequest names one Actions run. A run, not a job: neither forge can
// stop a single job of a running workflow.
type cancelRunRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	RunID    int64  `json:"runId"`
}

// trackedRepository reports whether the dashboard follows fullName on forge: a
// repository it lists, one with a pull request on the board, or one whose
// default branch the Main branches page shows. A run id alone doesn't say
// which repository it belongs to, so this is what keeps the route from
// cancelling runs in a repository the dashboard never shows.
func trackedRepository(ctx context.Context, deps Deps, forge, fullName string) bool {
	warmUpAggregator(ctx, deps)
	deps.Service.WaitFirstRefresh(ctx, deps.firstLoadWait())
	snap := deps.Service.Get()

	if slices.ContainsFunc(snap.Repos, func(r dashboard.Repo) bool {
		return string(r.Forge) == forge && r.FullName == fullName
	}) {
		return true
	}
	if slices.ContainsFunc(snap.PullRequests, func(p dashboard.PullRequest) bool {
		return string(p.Forge) == forge && p.Repo == fullName
	}) {
		return true
	}
	// The settings are read only when the cheaper lists didn't settle it.
	return slices.ContainsFunc(followedRows(ctx, deps, snap), func(b dashboard.MainBranch) bool {
		return string(b.Forge) == forge && b.FullName == fullName
	})
}

// handleCancelRun asks the forge to cancel the named workflow run, the one the
// pipeline checks dialog read off a running check. It answers 204 once the
// forge has accepted. The run id comes from the checks list, so the route is
// keyed by repository and run rather than by pull request, and a pull
// request's allowed actions can't guard it; the forge has the final say on a
// run that has already finished.
//
// A cancel is never queued for a rate-limit reset: by then the run may be a
// different one, started by a newer push, and a cancel can't be undone.
func handleCancelRun(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req cancelRunRequest
		if !decodeActionBody(w, r, &req) {
			return
		}
		if req.RunID <= 0 {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("runId", "runId must be a positive run id"))

			return
		}
		t, ok := validateActionTarget(w, pullRequestActionRequest{Forge: req.Forge, FullName: req.FullName})
		if !ok {
			return
		}

		src, _, ok := forgeSource(w, r, deps, req.Forge)
		if !ok {
			return
		}
		canceler, ok := capabilityOf[dashboard.RunCanceler](w, src, req.Forge, "doesn't support cancelling a run")
		if !ok {
			return
		}

		if !trackedRepository(r.Context(), deps, req.Forge, req.FullName) {
			const msg = "That repository isn't tracked by the dashboard."
			writeJSON(w, http.StatusNotFound, actionErrorBody{Error: "that repository isn't tracked", Code: string(dashboard.ActionUnknown), Message: msg})

			return
		}

		if err := canceler.CancelRun(r.Context(), t.owner, t.name, req.RunID); err != nil {
			slog.Warn("run cancel failed", "forge", req.Forge, "repo", req.FullName, "run", req.RunID, "error", err)
			writeActionRefusal(r.Context(), w, nil, dashboard.PullRequestActionCancelRun, t.owner, t.name, 0, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}
