package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// actionErrorBody matches components.schemas.ActionError.
type actionErrorBody struct {
	Error    string     `json:"error"`
	Code     string     `json:"code"`
	Message  string     `json:"message"`
	ResetsAt *time.Time `json:"resetsAt,omitempty"`
}

// writeActionRefusal answers a refused pull request action with the shared
// ActionError shape. It re-reads the PR through src (when src can) and
// lets dashboard.ClassifyActionRefusal turn that into a code, so every
// client gets the same reason. Refusals a re-read can't improve
// (permission, rate limit) skip it. If the re-read fails, or src can't do
// one, the answer is the original error with code unknown. The HTTP status
// stays what clientErrorStatus already gave for the original error, except
// that a PR found already merged or closed is always a 409.
//
// Shared by every pull request action: Merge, Close, Update branch, Enable
// auto-merge, and the Dependabot and Renovate rebases.
func writeActionRefusal(ctx context.Context, w http.ResponseWriter, src any, action dashboard.PullRequestAction, owner, name string, number int, actionErr error) {
	var state *dashboard.PullRequestState
	if !refusalNeedsNoReRead(actionErr) {
		if reader, ok := src.(dashboard.PullRequestStateReader); ok {
			if st, err := reader.ReadPullRequestState(ctx, owner, name, number); err != nil {
				slog.Warn("re-read after a refused action failed", "repo", owner+"/"+name, "number", number, "error", err)
			} else {
				state = &st
			}
		}
	}

	refusal := dashboard.ClassifyActionRefusalFor(action, actionErr, state)
	status := clientErrorStatus(actionErr)
	if refusal.Code == dashboard.ActionAlreadyMerged || refusal.Code == dashboard.ActionAlreadyClosed {
		status = http.StatusConflict
	}
	writeRefusal(w, status, refusal, actionErr, "action", string(action), "repo", owner+"/"+name, "number", number)
}

// refuseIfNotAllowed enforces dashboard.AllowedActions on the server (#978):
// when the pull request is on the user's board and its allowed actions say
// action is blocked, or doesn't apply, it answers 409 with the same code and
// message the board shows and reports true, so the caller never asks the
// forge. A pull request the board doesn't hold is left to the forge, which
// has the final say either way.
func refuseIfNotAllowed(w http.ResponseWriter, deps Deps, userID []byte, action dashboard.ActionName, forge, fullName string, number int) bool {
	pr, found := deps.Manager.FindPullRequest(userID, dashboard.Forge(forge), fullName, number)
	if !found {
		return false
	}

	for _, a := range dashboard.AllowedActions(pr) {
		if a.Action != action {
			continue
		}
		if a.Blocked == nil {
			return false
		}
		writeJSON(w, http.StatusConflict, actionErrorBody{
			Error:   a.Blocked.Message,
			Code:    string(a.Blocked.Code),
			Message: a.Blocked.Message,
		})

		return true
	}

	// Not offered at all: nothing a person could do about it from here.
	refusal := notOfferedRefusal(action, pr)
	writeJSON(w, http.StatusConflict, actionErrorBody{Error: refusal.Message, Code: string(refusal.Code), Message: refusal.Message})

	return true
}

// notOfferedRefusal says why an action isn't on a pull request's list at all,
// as plainly as the codes allow.
func notOfferedRefusal(action dashboard.ActionName, pr dashboard.PullRequest) dashboard.ActionRefusal {
	if action == dashboard.ActionAutoMerge {
		return autoMergeNotOffered(pr)
	}
	if action == dashboard.ActionUpdateBranch {
		if !pr.Behind || pr.Empty {
			return dashboard.ActionRefusal{Code: dashboard.ActionAlreadyUpToDate, Message: "Already up to date with the base branch."}
		}

		return dashboard.ActionRefusal{Code: dashboard.ActionNotMergeable, Message: "Dependabot and Renovate pull requests update through their own rebase."}
	}

	return dashboard.ActionRefusal{Code: dashboard.ActionNotMergeable, Message: "This action doesn't apply to this pull request."}
}

// writeRefusal answers with the shared ActionError. With code unknown the raw
// text (internal prefixes, API paths, a swagger URL) is for the log only
// (#796): the response carries the same plain words in `error` and
// `message`. logAttrs say which call was refused.
func writeRefusal(w http.ResponseWriter, status int, refusal dashboard.ActionRefusal, actionErr error, logAttrs ...any) {
	errText := actionErr.Error()
	if refusal.Code == dashboard.ActionUnknown {
		slog.Warn("forge call refused with no reason code", append(logAttrs, "status", status, "error", errText)...)
		errText = refusal.Message
	}
	writeJSON(w, status, actionErrorBody{
		Error:    errText,
		Code:     string(refusal.Code),
		Message:  refusal.Message,
		ResetsAt: refusal.ResetsAt,
	})
}

func refusalNeedsNoReRead(err error) bool {
	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	if !ok {
		return false
	}

	// A permission refusal is re-read too (#904): the pull request may just be
	// merged or closed. A rate limit isn't, since the re-read would be limited.
	return clientErr.Kind == dashboard.ForgeErrorRateLimited
}

// autoMergeNotOffered says why auto-merge isn't on a pull request's list, in
// the order dashboard.autoMergeOffered rules it out.
func autoMergeNotOffered(pr dashboard.PullRequest) dashboard.ActionRefusal {
	switch {
	case pr.Forge != dashboard.ForgeGitHub:
		return dashboard.ActionRefusal{Code: dashboard.ActionNotMergeable, Message: "Auto-merge is only available on GitHub."}
	case pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled:
		return dashboard.ActionRefusal{Code: dashboard.ActionNotMergeable, Message: "Auto-merge is already on for this pull request."}
	case pr.AutoMergeAllowed != nil && !*pr.AutoMergeAllowed:
		return dashboard.ActionRefusal{Code: dashboard.ActionAutoMergeNotAllowed, Message: "Auto-merge isn't allowed for this pull request. Turn it on in the repo's settings."}
	case pr.Empty:
		return dashboard.ActionRefusal{Code: dashboard.ActionAlreadyUpToDate, Message: "Already up to date with the target branch, so there is nothing to merge."}
	case pr.MergeStatus == dashboard.MergeConflicting:
		return dashboard.ActionRefusal{Code: dashboard.ActionConflict, Message: "Merge conflict. Resolve it on the forge first."}
	case pr.StackedOn != nil:
		return dashboard.ActionRefusal{Code: dashboard.ActionStacked, Message: "Stacked on another pull request. Merge that one first."}
	default:
		return dashboard.ActionRefusal{Code: dashboard.ActionReadyToMerge, Message: "This pull request is already ready to merge, so there's nothing for auto-merge to wait for. Use Merge instead."}
	}
}
