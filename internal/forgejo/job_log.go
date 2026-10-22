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
//
// The SDK buffers the whole log before returning it, so a very large log
// costs that much memory for the length of the call; the SDK offers no
// ranged or streaming read to bound it. NewJobLog keeps only the end.
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

// addFailureExcerpts fills Excerpt on the first few failed or timed-out Actions
// jobs among checks, from the end of their logs, as the GitHub client does. It
// is best effort: a job with no id, or a log the token can't read, keeps its
// check as it was, with the link to the run. A pull request's list and a
// branch's list both come through here, so the two boards agree.
func (c *Client) addFailureExcerpts(ctx context.Context, owner, name string, checks []dashboard.Check) {
	read := 0
	for i := range checks {
		if checks[i].JobID == 0 || (checks[i].State != dashboard.CheckFailure && checks[i].State != dashboard.CheckTimedOut) {
			continue
		}
		if read == dashboard.MaxExcerptJobs {
			return
		}
		read++
		log, err := c.JobLog(ctx, owner, name, checks[i].JobID)
		if err != nil {
			slog.Debug("forgejo job log unavailable", "job", checks[i].JobID, "err", err)

			continue
		}
		checks[i].Excerpt = dashboard.LogExcerpt(log.Text, log.Truncated)
	}
}
