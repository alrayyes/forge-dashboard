package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// PullRequestBody implements dashboard.PullRequestBodyEditor: the
// description of owner/name#number.
func (c *Client) PullRequestBody(ctx context.Context, owner, name string, number int) (string, error) {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return "", c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return pr.Body, nil
}

// SetPullRequestBody implements dashboard.PullRequestBodyEditor: replaces the
// description of owner/name#number and nothing else about it.
func (c *Client) SetPullRequestBody(ctx context.Context, owner, name string, number int, body string) error {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodPatch, "url", path)
	_, resp, err := c.sdk.EditPullRequest(owner, name, int64(number), gitea.EditPullRequestOption{Body: &body})
	if err != nil {
		return c.forgejoError(ctx, http.MethodPatch, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodPatch, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return nil
}
