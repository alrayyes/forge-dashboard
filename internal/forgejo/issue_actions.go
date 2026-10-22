package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// CloseIssue implements dashboard.IssueCloser: closes owner/name#number.
// Forgejo treats closing an issue that is already closed as done.
func (c *Client) CloseIssue(ctx context.Context, owner, name string, number int) error {
	return c.setIssueState(ctx, owner, name, number, gitea.StateClosed)
}

// ReopenIssue implements dashboard.IssueReopener: the undo for CloseIssue.
func (c *Client) ReopenIssue(ctx context.Context, owner, name string, number int) error {
	return c.setIssueState(ctx, owner, name, number, gitea.StateOpen)
}

func (c *Client) setIssueState(ctx context.Context, owner, name string, number int, state gitea.StateType) error {
	c = c.withContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPatch, "url", path)
	_, resp, err := c.sdk.EditIssue(owner, name, int64(number), gitea.EditIssueOption{State: &state})
	if err != nil {
		return c.forgejoError(ctx, http.MethodPatch, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodPatch, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return nil
}

// CommentIssue implements dashboard.IssueCommenter: posts body as a comment on
// owner/name#number. It needs the token's issue write scope, which closing
// needs too.
func (c *Client) CommentIssue(ctx context.Context, owner, name string, number int, body string) error {
	c = c.withContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/issues/%d/comments", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", path)
	_, resp, err := c.sdk.CreateIssueComment(owner, name, int64(number), gitea.CreateIssueCommentOption{Body: body})
	if err != nil {
		return c.forgejoError(ctx, http.MethodPost, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodPost, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return nil
}
