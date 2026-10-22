package forgejo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// jobLogReadWindow is how much of the end of a log is kept before cleaning.
// It is a few times MaxJobLogBytes so that stripping colour codes still
// leaves a full window of text.
const jobLogReadWindow = 4 * dashboard.MaxJobLogBytes

// jobLogErrorBody caps how much of a refusal's body is read for its message.
const jobLogErrorBody = 64 << 10

// JobLog reads the output of Actions job id, the end of it when it is long. A
// forge that does not serve job logs, a job the token cannot read and a job
// with no log answer with a classified client error, never with text.
//
// The SDK's job logs call buffers the whole log and offers no streaming read,
// so this makes the request itself and streams the body through a window that
// keeps only the last jobLogReadWindow bytes. Memory stays fixed however
// large the log is.
func (c *Client) JobLog(ctx context.Context, owner, name string, id int64) (dashboard.JobLog, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/logs", owner, name, id)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.instanceURL+"/api/v1"+path, nil)
	if err != nil {
		return dashboard.JobLog{}, fmt.Errorf("forgejo: build request: %w", err)
	}
	if c.token != "" {
		req.Header.Set("Authorization", "token "+c.token)
	}
	httpResp, err := c.httpClient.Do(req)
	if err != nil {
		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, nil, err)
	}
	defer func() { _ = httpResp.Body.Close() }()
	resp := &gitea.Response{Response: httpResp}
	if httpResp.StatusCode >= http.StatusMultipleChoices {
		msg, _ := io.ReadAll(io.LimitReader(httpResp.Body, jobLogErrorBody))
		reason := rawRequestErrorMessage(msg)
		if reason == "" {
			reason = httpResp.Status
		}

		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, resp, fmt.Errorf("%w: %s", errForgeRefused, reason))
	}

	tail, cut, err := readTail(httpResp.Body, jobLogReadWindow)
	if err != nil {
		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, httpResp.StatusCode, requestlog.OutcomeSuccess)

	return dashboard.NewJobLog(tail, cut), nil
}

// readTail reads r to the end and returns its last window bytes, and whether
// anything before them was dropped. It never holds more than 2*window bytes.
func readTail(r io.Reader, window int) ([]byte, bool, error) {
	buf := make([]byte, 0, 2*window)
	chunk := make([]byte, 32<<10)
	cut := false
	for {
		n, err := r.Read(chunk)
		buf = append(buf, chunk[:n]...)
		if len(buf) > 2*window-len(chunk) {
			keep := copy(buf, buf[len(buf)-window:])
			buf = buf[:keep]
			cut = true
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, false, fmt.Errorf("forgejo: read job log: %w", err)
		}
	}
	if len(buf) > window {
		buf = buf[len(buf)-window:]
		cut = true
	}

	return buf, cut, nil
}
