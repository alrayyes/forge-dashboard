package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// The issue write endpoints: close, reopen and comment. They are the issue
// dialog's footer, the sibling of the pull request ones. An issue has no
// allowed-actions list and no re-read to explain a refusal, so a refusal is
// classified from the forge's own answer alone (permission, rate limit,
// forge down).

// maxIssueCommentLen is GitHub's own comment limit, which Forgejo's is not
// below. Counted in characters, like the spec's maxLength.
const maxIssueCommentLen = 65536

// issueCommentRequest matches components.schemas.IssueCommentRequest.
type issueCommentRequest struct {
	pullRequestActionRequest

	Body string `json:"body"`
}

// handleIssueClose closes the named issue.
func handleIssueClose(deps Deps) http.HandlerFunc {
	return handleIssueStateAction(deps, "doesn't support closing issues", "issue close failed",
		func(ctx context.Context, c dashboard.IssueCloser, owner, name string, number int) error {
			return c.CloseIssue(ctx, owner, name, number)
		})
}

// handleIssueReopen reopens the named issue: the undo for handleIssueClose.
func handleIssueReopen(deps Deps) http.HandlerFunc {
	return handleIssueStateAction(deps, "doesn't support reopening issues", "issue reopen failed",
		func(ctx context.Context, c dashboard.IssueReopener, owner, name string, number int) error {
			return c.ReopenIssue(ctx, owner, name, number)
		})
}

func handleIssueStateAction[C any](deps Deps, unsupported, logMessage string, call func(ctx context.Context, c C, owner, name string, number int) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := readActionTarget(w, r)
		if !ok {
			return
		}
		src, _, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		capability, ok := capabilityOf[C](w, src, t.req.Forge, unsupported)
		if !ok {
			return
		}

		if err := call(r.Context(), capability, t.owner, t.name, t.req.Number); err != nil {
			refuseIssueAction(w, logMessage, t, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// handleIssueComment posts a comment on the named issue. The dialog's "Close
// with a comment" calls this first and Close second, so a failure of either
// half is known to the page and nothing is posted twice.
func handleIssueComment(deps Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req issueCommentRequest
		if !decodeActionBody(w, r, &req) {
			return
		}
		t, ok := validateActionTarget(w, r, req.pullRequestActionRequest)
		if !ok {
			return
		}
		if strings.TrimSpace(req.Body) == "" {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("body", "body must not be empty"))

			return
		}
		if utf8.RuneCountInString(req.Body) > maxIssueCommentLen {
			writeJSON(w, http.StatusBadRequest, fieldErrorBody("body", "body is too long"))

			return
		}
		src, _, ok := forgeSource(w, r, deps, t.req.Forge)
		if !ok {
			return
		}
		commenter, ok := capabilityOf[dashboard.IssueCommenter](w, src, t.req.Forge, "doesn't support commenting on issues")
		if !ok {
			return
		}

		if err := commenter.CommentIssue(r.Context(), t.owner, t.name, t.req.Number, req.Body); err != nil {
			refuseIssueAction(w, "issue comment failed", t, err)

			return
		}

		w.WriteHeader(http.StatusNoContent)
	}
}

// refuseIssueAction answers a refused issue write with the shared ActionError.
func refuseIssueAction(w http.ResponseWriter, logMessage string, t actionTarget, err error) {
	slog.Warn(logMessage, "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number, "error", err)

	refusal := dashboard.ClassifyForgeRefusal(err)
	if clientErr, ok := errors.AsType[*dashboard.ClientError](err); ok && clientErr.Kind == dashboard.ForgeErrorNotFound {
		refusal.Message = "The forge couldn't find this issue, or the token can't see it."
	}
	writeRefusal(w, clientErrorStatus(err), refusal, err, "forge", t.req.Forge, "repo", t.req.FullName, "number", t.req.Number)
}
