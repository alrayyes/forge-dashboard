package forgejo

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"sync"
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
	return c.jobLog(ctx, owner, name, id, jobLogReadWindow)
}

// excerptReadWindow is how much of a log's end an excerpt read keeps: the
// excerpt is 20 lines or 2 KB, so a small window holds it with room for the
// colour codes, and five reads at once stay light. It is the tail the GitHub
// client keeps for the same excerpt.
const excerptReadWindow = 16 << 10

// jobLog is JobLog with the size of the window kept from the end of the log.
func (c *Client) jobLog(ctx context.Context, owner, name string, id int64, window int) (dashboard.JobLog, error) {
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
		if errors.Is(ctx.Err(), context.Canceled) {
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
		if httpResp.StatusCode == http.StatusNotFound {
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
		if errors.Is(ctx.Err(), context.Canceled) {
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

// addFailureExcerpts fills Excerpt on the newest few failed or timed-out Actions
// jobs among checks, from the end of their logs, as the GitHub client does. A
// pull request's list and a branch's list both come through here, so the two
// boards agree. keys[i] names check i's job (its id and finish time, so a rerun
// reads afresh; a job with no finish time is named by its id alone), and
// finished[i] is when it finished, zero if unknown. A job's log stops changing
// a moment after it finishes, so an excerpt read from a settled log is kept for
// good and a red default branch costs no log read per poll. One read before
// that, or for a job with no finish time, is kept for a minute only, so a log
// that was still being flushed is read once more. A read that failed, or found
// the log empty, is remembered briefly too, so such a log isn't asked for on
// every poll.
//
// It is best effort: a job with no id, or a log the token can't read, keeps its
// check as it was, with the link to the run. Newest first (the highest job id),
// so jobs of superseded runs don't use up the budget; only reads count against
// dashboard.MaxExcerptJobs, not excerpts already kept. The reads run together,
// each under dashboard.ExcerptReadTimeout; the first refusal for a missing
// permission, or for a rate limit, cancels the rest, since they would be
// refused the same way.
func (c *Client) addFailureExcerpts(ctx context.Context, owner, name string, checks []dashboard.Check, keys []string, finished []time.Time) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	reads := 0
	for _, i := range newestFailures(checks) {
		if keys[i] != "" {
			if text, ok := c.excerpts.get(keys[i]); ok {
				checks[i].Excerpt = text

				continue
			}
			if c.excerpts.recentlyFailed(keys[i]) {
				continue
			}
		}
		if reads == dashboard.MaxExcerptJobs {
			// Older jobs may still have a kept excerpt, so keep looking.
			continue
		}
		// A refusal elsewhere in the list (or a gone caller) dooms every read
		// not yet started; sending it would only record a failed request.
		if ctx.Err() != nil {
			continue
		}
		reads++
		wg.Go(func() { c.fillExcerpt(ctx, cancel, owner, name, &checks[i], keys[i], c.logSettled(finished, i)) })
	}
	wg.Wait()
}

// logSettled reports whether check i's log is final: its job has been finished
// a while, since a read just after the finish may have missed lines the runner
// had yet to flush. No finish times (nil) means every log is taken as settled.
func (c *Client) logSettled(finished []time.Time, i int) bool {
	if finished == nil {
		return true
	}

	return !finished[i].IsZero() && c.excerpts.now().Sub(finished[i]) >= excerptSettleDelay
}

// fillExcerpt reads one failed job's log into check.Excerpt and keeps the result
// under key, when it has one.
func (c *Client) fillExcerpt(ctx context.Context, cancel context.CancelFunc, owner, name string, check *dashboard.Check, key string, settled bool) {
	text, err := c.readExcerpt(ctx, owner, name, check.JobID)
	if err != nil {
		slog.Debug("forgejo job log unavailable", "job", check.JobID, "err", err)
		// A sibling's cancel says nothing about this log; the read's own error
		// does, even when it lands just after the cancel.
		if key != "" && !errors.Is(err, context.Canceled) {
			c.excerpts.fail(key)
		}
		// A refused token or a limited forge fails every sibling alike; a
		// missing log is only that job's.
		if clientErr, ok := errors.AsType[*dashboard.ClientError](err); ok && (clientErr.Kind == dashboard.ForgeErrorUnauthorized || clientErr.Kind == dashboard.ForgeErrorRateLimited) {
			cancel()
		}

		return
	}
	check.Excerpt = text
	if key == "" {
		return
	}
	if text == "" {
		// An empty log may only not have been flushed yet: ask again after the
		// same short wait as a failed read, not on every poll, so it doesn't
		// hold one of the read slots each time.
		c.excerpts.fail(key)

		return
	}
	c.excerpts.put(key, text, settled)
}

// newestFailures is the indexes of the failed or timed-out checks that have a
// job id, newest first (the highest id).
func newestFailures(checks []dashboard.Check) []int {
	var picked []int
	for i := range checks {
		if checks[i].JobID != 0 && (checks[i].State == dashboard.CheckFailure || checks[i].State == dashboard.CheckTimedOut) {
			picked = append(picked, i)
		}
	}
	slices.SortStableFunc(picked, func(a, b int) int { return cmp.Compare(checks[b].JobID, checks[a].JobID) })

	return picked
}

// readExcerpt reads job id's log under c.excerptTimeout and cuts its excerpt.
func (c *Client) readExcerpt(ctx context.Context, owner, name string, id int64) (string, error) {
	ctx, done := context.WithTimeout(ctx, c.excerptTimeout)
	defer done()
	log, err := c.jobLog(ctx, owner, name, id, excerptReadWindow)
	if err != nil {
		return "", err
	}

	// NewJobLog has already dropped a cut log's partial first line.
	return dashboard.LogExcerpt(log.Text, false), nil
}
