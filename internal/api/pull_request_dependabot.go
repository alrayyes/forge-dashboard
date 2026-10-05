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

// handlePullRequestDependabotAction posts one of Dependabot's own
// documented PR-comment commands on the named pull request —
// dashboard.PullRequestCommenter posts the comment; this handler owns
// picking which exact text goes out. Follows the same shape
// handlePullRequestUpdateBranch already established.
func handlePullRequestDependabotAction(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := auth.UserFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusInternalServerError, errorBody("no authenticated user in context"))

			return
		}

		var req pullRequestDependabotActionRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, errorBody("invalid request body"))

			return
		}

		body, ok := dependabotCommentBodies[req.Action]
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`action must be "rebase" or "recreate"`))

			return
		}

		owner, name, ok := splitFullName(req.FullName)
		if !ok {
			writeJSON(w, http.StatusBadRequest, errorBody(`fullName must be "owner/repo"`))

			return
		}

		action := dashboard.ActionDependabotRebase
		if req.Action == "recreate" {
			action = dashboard.ActionDependabotRecreate
		}
		if refuseIfNotAllowed(w, deps, u.ID, action, req.Forge, req.FullName, req.Number) {
			return
		}

		creds, err := deps.SettingsStore.Get(r.Context(), u.ID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, errorBody("could not load settings"))

			return
		}

		var commenter dashboard.PullRequestCommenter
		for _, src := range deps.BuildSources(u.ID, creds) {
			if string(src.Forge()) != req.Forge {
				continue
			}
			if reason := dashboard.DependabotCommandsBlockedReason(src); reason != "" {
				writeJSON(w, http.StatusConflict, actionErrorBody{Error: reason, Code: string(dashboard.ActionPermission), Message: reason})

				return
			}
			c, supported := src.(dashboard.PullRequestCommenter)
			if !supported {
				writeJSON(w, http.StatusBadRequest, errorBody(req.Forge+" doesn't support commenting on pull requests"))

				return
			}
			commenter = c

			break
		}
		if commenter == nil {
			writeJSON(w, http.StatusBadRequest, errorBody("no "+req.Forge+" credentials saved"))

			return
		}

		if err := commenter.CommentPullRequest(r.Context(), owner, name, req.Number, body); err != nil {
			slog.Warn("dependabot pull request action failed", "forge", req.Forge, "repo", req.FullName, "number", req.Number, "action", req.Action, "error", err)
			writeActionRefusal(r.Context(), w, commenter, dashboard.PullRequestActionDependabot, owner, name, req.Number, err)

			return
		}

		deps.Manager.RecordBotRequest(u.ID, dashboard.Forge(req.Forge), req.FullName, req.Number, dashboard.BotDependabot, dashboard.BotAction(req.Action))

		w.WriteHeader(http.StatusNoContent)
	}
}
