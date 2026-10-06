package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// dependabotCommentBodies maps the only two actions this endpoint accepts
// to the exact comment text Dependabot's own comment-command interface
// documents (docs.github.com/en/code-security/dependabot/working-with-
// dependabot/managing-pull-requests-for-dependency-updates). Deliberately
// not a generic "post any comment" endpoint — the request names an action,
// not a body, and only these two ever get sent.
var dependabotCommentBodies = map[string]string{
	"rebase":   dashboard.DependabotRebaseComment,
	"recreate": dashboard.DependabotRecreateComment,
}

// pullRequestDependabotActionRequest matches
// components.schemas.PullRequestDependabotActionRequest.
type pullRequestDependabotActionRequest struct {
	Forge    string `json:"forge"`
	FullName string `json:"fullName"`
	Number   int    `json:"number"`
	Action   string `json:"action"`
}

// dependabotActions maps the request's action to the entry of the board's
// allowed actions that has to be there for it.
var dependabotActions = map[string]dashboard.ActionName{
	"rebase":   dashboard.ActionDependabotRebase,
	"recreate": dashboard.ActionDependabotRecreate,
}

// dependabotTarget is an actionTarget plus which command to send and the exact
// comment text for it.
type dependabotTarget struct {
	actionTarget
	action  string
	comment string
}

// readDependabotTarget reads who is asking, the action and which pull request,
// and answers 500 or 400 itself when it can't. The action is checked before
// the repo name, which is the order this endpoint always had.
func readDependabotTarget(w http.ResponseWriter, r *http.Request) (dependabotTarget, bool) {
	u, ok := auth.UserFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

		return dependabotTarget{}, false
	}

	var req pullRequestDependabotActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

		return dependabotTarget{}, false
	}

	if overBound(w, bound{"fullName", req.FullName, maxRepoFullNameLen}) {
		return dependabotTarget{}, false
	}
	if req.Number > maxPullRequestNumber {
		writeJSON(w, http.StatusBadRequest, fieldErrorBody("number", "number is too large"))

		return dependabotTarget{}, false
	}

	comment, ok := dependabotCommentBodies[req.Action]
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`action must be "rebase" or "recreate"`))

		return dependabotTarget{}, false
	}

	owner, name, ok := splitFullName(req.FullName)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

		return dependabotTarget{}, false
	}

	return dependabotTarget{
		user:    u,
		req:     pullRequestActionRequest{Forge: req.Forge, FullName: req.FullName, Number: req.Number},
		owner:   owner,
		name:    name,
		action:  req.Action,
		comment: comment,
	}, true
}

// handlePullRequestDependabotAction posts one of Dependabot's own
// documented PR-comment commands on the named pull request —
// dashboard.PullRequestCommenter posts the comment; this handler owns
// picking which exact text goes out. Follows the same shape
// handlePullRequestUpdateBranch already established.
func handlePullRequestDependabotAction(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readDependabotTarget(w, r)
		if !ok {
			return
		}
		if refuseIfNotAllowed(w, deps, t.user.ID, dependabotActions[t.action], t.req.Forge, t.req.FullName, t.req.Number) {
			return
		}

		src, _, ok := forgeSource(w, r, deps, t.user.ID, t.req.Forge)
		if !ok {
			return
		}
		if reason := dashboard.DependabotCommandsBlockedReason(src); reason != "" {
			writeJSON(w, http.StatusConflict, actionErrorBody{Error: reason, Code: string(dashboard.ActionPermission), Message: reason})

			return
		}
		commenter, ok := capabilityOf[dashboard.PullRequestCommenter](w, src, t.req.Forge, "doesn't support commenting on pull requests")
		if !ok {
			return
		}

		if err := commenter.CommentPullRequest(r.Context(), t.owner, t.name, t.req.Number, t.comment); err != nil {
			slog.Warn("dependabot pull request action failed", "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "action", t.action, "error", err)
			writeActionRefusal(r.Context(), w, commenter, dashboard.PullRequestActionDependabot, t.owner, t.name, t.req.Number, err)

			return
		}

		deps.Manager.RecordBotRequest(t.user.ID, dashboard.Forge(t.req.Forge), t.req.FullName, t.req.Number, dashboard.BotDependabot, dashboard.BotAction(t.action))

		w.WriteHeader(http.StatusNoContent)
	}
}
