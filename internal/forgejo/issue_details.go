package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// GetIssueDetails implements dashboard.IssueDetailer: the description, the
// first comments and the thumbs reactions on each of owner/name#number, at the
// same cost as GetPullRequestDetails (1 call for the issue instead of the pull
// request, then the shared thread reads).
func (c *Client) GetIssueDetails(ctx context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	c = c.withContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/issues/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	issue, resp, err := c.sdk.GetIssue(owner, name, int64(number))
	if err != nil {
		return dashboard.IssueDetails{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	details, err := c.threadDetails(ctx, owner, name, number, issue.Body)
	if err != nil {
		return dashboard.IssueDetails{}, err
	}
	details.State = dashboard.IssueStateOpen
	if issue.State == gitea.StateClosed {
		details.State = dashboard.IssueStateClosed
	}

	return details, nil
}
