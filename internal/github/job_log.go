package github

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

var (
	errJobLogRefused = errors.New("github: the forge refused the request")
	errJobLogExpired = errors.New("github: the job's log is gone")
	errJobLogStatus  = errors.New("github: unexpected job log status")
)

// JobLog reads the output of Actions job id, the end of it when it is long.
// GitHub answers the logs request with a redirect to a short-lived blob URL;
// that blob is fetched without the token, asking only for its last bytes. A
// job the token cannot read, a log that has expired and a check run that is
// not an Actions job come back as classified client errors, never as text.
func (c *Client) JobLog(ctx context.Context, owner, name string, id int64) (dashboard.JobLog, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/logs", owner, name, id)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	loc, resp, err := c.restClient.Actions.GetWorkflowJobLogs(ctx, owner, name, id, 1)
	if err != nil {
		// The SDK answers a status other than the redirect with a plain error
		// and the response, so the status is what classifies it.
		if resp != nil && resp.Response != nil {
			if kind := forgeErrorKindFromStatus(resp.StatusCode); kind != dashboard.ForgeErrorUnknown {
				c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, string(kind), nil)

				return dashboard.JobLog{}, &dashboard.ClientError{Kind: kind, Err: fmt.Errorf("%w: GET %s: %s", errJobLogRefused, path, resp.Status)}
			}
		}

		return dashboard.JobLog{}, asClientError(c.restError(ctx, http.MethodGet, path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)

	fetchCtx, cancel := context.WithTimeout(ctx, logFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, c.restClient.BaseURL.ResolveReference(loc).String(), nil)
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("github: job log request: %w", err)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=-%d", dashboard.MaxJobLogBytes))
	blob, err := (&http.Client{Timeout: logFetchTimeout}).Do(req)
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("github: job log download: %w", err)
	}
	defer func() { _ = blob.Body.Close() }()

	switch blob.StatusCode {
	case http.StatusOK, http.StatusPartialContent:
	case http.StatusNotFound, http.StatusGone:
		return dashboard.JobLog{}, &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  fmt.Errorf("%w: job %d has expired", errJobLogExpired, id),
		}
	case http.StatusForbidden, http.StatusUnauthorized:
		return dashboard.JobLog{}, &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  fmt.Errorf("%w: the log of job %d is not readable", errJobLogRefused, id),
		}
	default:
		return dashboard.JobLog{}, fmt.Errorf("%w: download answered %d", errJobLogStatus, blob.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(blob.Body, maxLogBody))
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("github: job log download: %w", err)
	}

	return dashboard.NewJobLog(body, blob.StatusCode == http.StatusPartialContent), nil
}
