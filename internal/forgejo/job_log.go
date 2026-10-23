package forgejo

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

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
	return c.jobLog(ctx, owner, name, id, jobLogReadWindow, false)
}

// excerptReadWindow is how much of a log's end an excerpt read keeps: the
// excerpt is 20 lines or 2 KB, so a small window holds it with room for the
// colour codes, and five reads at once stay light. It is the tail the GitHub
// client keeps for the same excerpt.
const excerptReadWindow = 16 << 10

// jobLog is JobLog with the size of the window kept from the end of the log.
// missingIsOrdinary logs a 404 as a request made, not as an error: an excerpt
// read asks for logs nobody requested, and a pruned one is expected.
func (c *Client) jobLog(ctx context.Context, owner, name string, id int64, window int, missingIsOrdinary bool) (dashboard.JobLog, error) {
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
		if errors.Is(err, context.Canceled) {
			// The caller gave up (a sibling read was refused, or the caller left):
			// that is not this request failing, so it is not recorded as one.
			return dashboard.JobLog{}, fmt.Errorf("forgejo: read job log: %w", err)
		}

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

		refusal := fmt.Errorf("%w: %s", errForgeRefused, reason)
		if missingIsOrdinary && httpResp.StatusCode == http.StatusNotFound {
			// A log that was pruned, or a job that keeps none, is an ordinary
			// answer: the request is logged as made, not as an error.
			clientErr, status := classifyForgejoError(http.MethodGet, path, resp, refusal)
			c.recordRequest(ctx, http.MethodGet, path, status, requestlog.OutcomeSuccess)

			return dashboard.JobLog{}, clientErr
		}

		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, resp, refusal)
	}

	tail, cut, err := readTail(httpResp.Body, window)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return dashboard.JobLog{}, fmt.Errorf("forgejo: read job log: %w", err)
		}

		return dashboard.JobLog{}, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, path, httpResp.StatusCode, requestlog.OutcomeSuccess)

	return dashboard.NewJobLog(tail, cut), nil
}

// readTail reads r to the end and returns its last window bytes, and whether
// anything before them was dropped. It never holds more than 2*window bytes.
func readTail(r io.Reader, window int) ([]byte, bool, error) {
	buf := make([]byte, 0, 2*window)
	chunk := make([]byte, min(32<<10, window))
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

// excerptKey names one check's job for the excerpt cache: its id, attempt, start
// and finish time, so a rerun reads afresh even if the forge reuses the id. A
// job missing a time is named by what it has. finished is when it finished,
// zero if unknown.
type excerptKey struct {
	key      string
	finished time.Time
}

// newExcerptKey names job j of owner/name, by whichever of its attempt, start
// and finish time the forge sent.
func newExcerptKey(owner, name string, j *gitea.ActionWorkflowJob) excerptKey {
	key := fmt.Sprintf("%s/%s#%d", owner, name, j.ID)
	if j.RunAttempt != 0 {
		key = fmt.Sprintf("%s.%d", key, j.RunAttempt)
	}
	if !j.StartedAt.IsZero() {
		key = fmt.Sprintf("%s+%d", key, j.StartedAt.UnixNano())
	}
	if !j.CompletedAt.IsZero() {
		key = fmt.Sprintf("%s@%d", key, j.CompletedAt.UnixNano())
	}

	return excerptKey{key: key, finished: j.CompletedAt}
}

// settled reports whether the job's log is final: it has been finished a while,
// since a read just after the finish may have missed lines the runner had yet
// to flush.
func (k excerptKey) settled(now time.Time) bool {
	return !k.finished.IsZero() && now.Sub(k.finished) >= excerptSettleDelay
}

// rememberFailedJobs notes the excerpt key of each failed or timed-out job
// among checks, so a later JobExcerpt can tell a settled log from one still
// being flushed and a rerun from the first attempt, though the log endpoint
// is asked for a job id alone. It reads no log. jobs[i] names check i's job.
func (c *Client) rememberFailedJobs(owner, name string, checks []dashboard.Check, jobs []excerptKey) {
	for _, i := range newestFailures(checks) {
		c.excerpts.remember(owner, name, checks[i].JobID, jobs[i])
	}
}

// JobExcerpt reads the excerpt of one failed job: the end of its log as plain
// text, the way the GitHub client fills it. It is read when someone is about to
// look at the check, never while a checks list is built, so a slow log delays
// only its own excerpt, bounded by dashboard.ExcerptReadTimeout.
//
// A job's log stops changing a moment after it finishes, so an excerpt read
// from a settled log is kept for good. One read before that, or for a job with
// no finish time, is kept for a minute only, so a log that was still being
// flushed is read once more. A read that failed, or found the log empty, is
// remembered briefly too and answers with no excerpt until then, so a log that
// can't be read isn't asked for on every look.
//
// A missing log is no excerpt, not an error. A refused token or a rate limit
// is returned, so the caller can stop asking for the rest.
func (c *Client) JobExcerpt(ctx context.Context, owner, name string, id int64) (string, error) {
	jk := c.excerpts.keyFor(owner, name, id)
	if text, ok := c.excerpts.get(jk.key); ok {
		return text, nil
	}
	if c.excerpts.recentlyFailed(jk.key) {
		return "", nil
	}
	text, err := c.readExcerpt(ctx, owner, name, id)
	if err != nil {
		slog.Debug("forgejo job log unavailable", "job", id, "err", err)
		// A caller that left says nothing about this log; the read's own error
		// does, even when it lands just after.
		if !errors.Is(err, context.Canceled) {
			c.excerpts.fail(jk.key)
		}
		if clientErr, ok := errors.AsType[*dashboard.ClientError](err); ok && clientErr.Kind == dashboard.ForgeErrorNotFound {
			return "", nil
		}

		return "", err
	}
	if text == "" {
		// An empty log may only not have been flushed yet: ask again after the
		// same short wait as a failed read, not on every look.
		c.excerpts.fail(jk.key)

		return "", nil
	}
	c.excerpts.put(jk.key, text, jk.settled(c.excerpts.now()))

	return text, nil
}

// newestFailures is the indexes of the failed or timed-out checks that have a
// job id.
func newestFailures(checks []dashboard.Check) []int {
	var picked []int
	for i := range checks {
		if checks[i].JobID != 0 && (checks[i].State == dashboard.CheckFailure || checks[i].State == dashboard.CheckTimedOut) {
			picked = append(picked, i)
		}
	}

	return picked
}

// readExcerpt reads job id's log under c.excerptTimeout and cuts its excerpt.
func (c *Client) readExcerpt(ctx context.Context, owner, name string, id int64) (string, error) {
	ctx, done := context.WithTimeout(ctx, c.excerptTimeout)
	defer done()
	log, err := c.jobLog(ctx, owner, name, id, excerptReadWindow, true)
	if err != nil {
		return "", err
	}

	// NewJobLog has already dropped a cut log's partial first line.
	return dashboard.LogExcerpt(log.Text, false), nil
}
