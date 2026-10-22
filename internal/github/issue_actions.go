package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	ghsdk "github.com/google/go-github/v75/github"
)

// CloseIssue implements dashboard.IssueCloser: closes owner/name#number. GitHub
// treats closing an issue that is already closed as done, so there is no
// "already closed" refusal to classify.
func (c *Client) CloseIssue(ctx context.Context, owner, name string, number int) error {
	return c.setIssueState(ctx, owner, name, number, "closed")
}

// ReopenIssue implements dashboard.IssueReopener: the undo for CloseIssue.
func (c *Client) ReopenIssue(ctx context.Context, owner, name string, number int) error {
	return c.setIssueState(ctx, owner, name, number, "open")
}

// CommentIssue implements dashboard.IssueCommenter: posts body as a comment on
// owner/name#number.
func (c *Client) CommentIssue(ctx context.Context, owner, name string, number int, body string) error {
	return c.postComment(ctx, owner, name, number, body)
}

func (c *Client) setIssueState(ctx context.Context, owner, name string, number int, state string) error {
	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, name, number)
	slog.Debug("github request", "method", http.MethodPatch, "url", path)
	_, resp, err := c.restClient.Issues.Edit(ctx, owner, name, number, &ghsdk.IssueRequest{State: &state})
	if err != nil {
		return asClientError(c.restError(ctx, http.MethodPatch, path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodPatch, path, resp)

	return nil
}
