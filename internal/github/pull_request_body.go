package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	ghsdk "github.com/google/go-github/v75/github"
)

// PullRequestBody implements dashboard.PullRequestBodyEditor: the
// description of owner/name#number.
func (c *Client) PullRequestBody(ctx context.Context, owner, name string, number int) (string, error) {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	pr, resp, err := c.restClient.PullRequests.Get(ctx, owner, name, number)
	if err != nil {
		return "", asClientError(c.restError(ctx, http.MethodGet, path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)

	return pr.GetBody(), nil
}

// SetPullRequestBody implements dashboard.PullRequestBodyEditor: replaces the
// description of owner/name#number and nothing else about it.
func (c *Client) SetPullRequestBody(ctx context.Context, owner, name string, number int, body string) error {
	path := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("github request", "method", http.MethodPatch, "url", path)
	_, resp, err := c.restClient.PullRequests.Edit(ctx, owner, name, number, &ghsdk.PullRequest{Body: &body})
	if err != nil {
		return asClientError(c.restError(ctx, http.MethodPatch, path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodPatch, path, resp)

	return nil
}
