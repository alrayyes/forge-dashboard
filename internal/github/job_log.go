package github

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

var (
	errJobLogRefused = errors.New("github: the forge refused the request")
	errJobLogExpired = errors.New("github: the job's log is gone")
	errJobLogStatus  = errors.New("github: unexpected job log status")

	errJobLogDownload = errors.New("github: job log download failed")
	errJobLogRedirect = errors.New("github: refused job log redirect")
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
		return dashboard.JobLog{}, c.logRequestError(ctx, path, resp, err)
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)

	blob, cancel, err := c.fetchLogBlob(ctx, loc, dashboard.MaxJobLogBytes)
	if err != nil {
		return dashboard.JobLog{}, err
	}
	defer cancel()
	defer func() { _ = blob.Body.Close() }()

	if err := blobStatusError(blob.StatusCode, id); err != nil {
		return dashboard.JobLog{}, err
	}

	body, skipped, err := readTail(blob.Body, dashboard.MaxJobLogBytes)
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}
	// A 206 that starts at byte 0 is the whole log; any other 206 starts
	// mid-log, and a 200 that was longer than the window lost its start.
	cut := skipped || (blob.StatusCode == http.StatusPartialContent && !startsAtZero(blob.Header.Get("Content-Range")))

	return dashboard.NewJobLog(body, cut), nil
}

// logRequestError classifies a failed logs request. The SDK answers a status
// other than the redirect with a plain error and the response, so the status
// is what classifies it; an exhausted rate limit is a 403 with no budget left.
func (c *Client) logRequestError(ctx context.Context, path string, resp *ghsdk.Response, err error) error {
	if resp != nil && resp.Response != nil {
		kind := forgeErrorKindFromStatus(resp.StatusCode)
		if resp.StatusCode == http.StatusForbidden && (resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "") {
			kind = dashboard.ForgeErrorRateLimited
		}
		if kind != dashboard.ForgeErrorUnknown {
			c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, string(kind), nil)

			return &dashboard.ClientError{Kind: kind, Err: fmt.Errorf("%w: GET %s: %s", errJobLogRefused, path, resp.Status)}
		}
	}

	return asClientError(c.restError(ctx, http.MethodGet, path, err))
}

// blobStatusError classifies the status the blob host answered with: nil for
// the two that carry text.
func blobStatusError(status int, id int64) error {
	switch status {
	case http.StatusOK, http.StatusPartialContent:
		return nil
	case http.StatusNotFound, http.StatusGone:
		return &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  fmt.Errorf("%w: job %d has expired", errJobLogExpired, id),
		}
	case http.StatusForbidden, http.StatusUnauthorized:
		return &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  fmt.Errorf("%w: the log of job %d is not readable", errJobLogRefused, id),
		}
	default:
		return fmt.Errorf("%w: download answered %d", errJobLogStatus, status)
	}
}

// fetchLogBlob asks the short-lived blob URL a logs request redirected to for
// its last n bytes. The request carries no token. A redirect target must be
// https, or the API's own origin (a GitHub Enterprise Server host, a test), so
// a hostile Location can't make the server fetch from an arbitrary plain-http
// host. Errors never carry the URL, which is a credential. The returned cancel
// releases the request's timeout; call it once the body is read.
func (c *Client) fetchLogBlob(ctx context.Context, loc *url.URL, n int) (*http.Response, context.CancelFunc, error) {
	target := c.restClient.BaseURL.ResolveReference(loc)
	if target.Scheme != "https" && (target.Scheme != c.restClient.BaseURL.Scheme || target.Host != c.restClient.BaseURL.Host) {
		return nil, nil, fmt.Errorf("%w: the log redirect is not https", errJobLogRedirect)
	}
	fetchCtx, cancel := context.WithTimeout(ctx, logFetchTimeout)
	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		cancel()

		return nil, nil, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=-%d", n))
	blob, err := (&http.Client{Timeout: logFetchTimeout}).Do(req)
	if err != nil {
		cancel()

		return nil, nil, fmt.Errorf("%w: %w", errJobLogDownload, redactedCause(err))
	}

	return blob, cancel, nil
}

// redactedCause is err without the URL a *url.Error carries.
func redactedCause(err error) error {
	if ue, ok := errors.AsType[*url.Error](err); ok {
		return ue.Err
	}

	return err
}

// readTail reads r to its end but keeps only the last n bytes, so a body
// longer than asked for (a host that ignored the range) costs no more memory
// than n. skipped says bytes were dropped from the start.
func readTail(r io.Reader, n int) (tail []byte, skipped bool, err error) {
	buf := make([]byte, 0, 2*n)
	chunk := make([]byte, 32*1024)
	for {
		m, rerr := r.Read(chunk)
		buf = append(buf, chunk[:m]...)
		if len(buf) >= 2*n {
			buf = append(buf[:0], buf[len(buf)-n:]...)
			skipped = true
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return nil, false, fmt.Errorf("read log: %w", rerr)
		}
	}
	if len(buf) > n {
		buf, skipped = buf[len(buf)-n:], true
	}

	return buf, skipped, nil
}

// startsAtZero reports whether a Content-Range header ("bytes 0-99/100")
// starts at the first byte. A missing or odd header counts as not.
func startsAtZero(header string) bool {
	return strings.HasPrefix(header, "bytes 0-")
}
