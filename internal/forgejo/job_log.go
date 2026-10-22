package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// JobLog reads the output of Actions job id through the SDK's job logs call,
// the end of it when it is long. A forge that does not serve job logs, a job
// the token cannot read and a job with no log answer with a classified client
// error, never with text.
func (c *Client) JobLog(ctx context.Context, owner, name string, id int64) (dashboard.JobLog, error) {
	c = c.withContext(ctx)
	path := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/logs", owner, name, id)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	raw, resp, err := c.sdk.GetRepoActionJobLogs(owner, name, id)
	if err != nil {
		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	return dashboard.NewJobLog(raw, false), nil
}
