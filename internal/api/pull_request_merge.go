package api

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// pullRequestActionRequest matches components.schemas.PullRequestActionRequest.
type pullRequestActionRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number"`
}

// pullRequestMergeRequest matches components.schemas.PullRequestMergeRequest.
type pullRequestMergeRequest struct {
	pullRequestActionRequest
	DeleteBranch bool `json:"deleteBranch"`
}

// branchDeletionBody matches components.schemas.BranchDeletion.
type branchDeletionBody struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason,omitempty"`
}

// handlePullRequestMerge merges the named pull request using its repo's
// own configured default merge method — dashboard.PullRequestMerger's own
// MergePullRequest decides how, per forge. Follows the same shape
// handleWebhookEnsure already established for a write to a forge.
func handlePullRequestMerge(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req pullRequestMergeRequest
		if !decodeActionBody(w, r, &req) {
			return
		}
		t, ok := validateActionTarget(w, req.pullRequestActionRequest)
		if !ok {
			return
		}
		if refuseIfNotAllowed(r.Context(), w, deps, dashboard.ActionMerge, t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		merger, ok := capabilityOf[dashboard.PullRequestMerger](w, src, t.req.Forge, "doesn't support merging pull requests")
		if !ok {
			return
		}

		if err := merger.MergePullRequest(r.Context(), t.owner, t.name, t.req.Number); err != nil {
			slog.Warn("pull request merge failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)
			writeActionRefusal(r.Context(), w, merger, dashboard.PullRequestActionMerge, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Service.MarkSettled(dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number)
		if !req.DeleteBranch {
			w.WriteHeader(http.StatusNoContent)

			return
		}

		deletion := deleteMergedBranch(r.Context(), src, t)
		writeJSON(w, http.StatusOK, map[string]branchDeletionBody{
			"branchDeletion": {Outcome: string(deletion.Outcome), Reason: string(deletion.Reason)},
		})
	}
}

// deleteMergedBranch asks the source to delete the branch of a pull request
// that has just merged. A source that can't is reported as skipped, since
// the merge is done either way.
func deleteMergedBranch(ctx context.Context, src dashboard.Source, t actionTarget) dashboard.BranchDeletion {
	deleter, ok := src.(dashboard.PullRequestBranchDeleter)
	if !ok {
		return dashboard.BranchDeletion{Outcome: dashboard.BranchSkipped, Reason: dashboard.SkipUnsupported}
	}

	return deleter.DeletePullRequestBranch(ctx, t.owner, t.name, t.req.Number)
}
