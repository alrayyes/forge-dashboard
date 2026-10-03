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
	errText := actionErr.Error()
	if refusal.Code == dashboard.ActionUnknown {
		// No code fits, so the raw text (internal prefixes, API paths, a
		// swagger URL) is for the log only (#796). The response carries the
		// same plain words in `error` and `message`.
		slog.Warn("pull request action refused with no reason code", "action", string(action), "repo", owner+"/"+name, "number", number, "status", status, "error", errText)
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

	return clientErr.Kind == dashboard.ForgeErrorRateLimited || clientErr.Kind == dashboard.ForgeErrorUnauthorized
}
