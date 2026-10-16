package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

const (
	// maxTimelineReads caps the timeline requests one listing makes. It is
	// also the number made at once. A repo with more eligible pull requests
	// reads the ones checked longest ago first and keeps the rest's last known
	// value until the next refresh (#1571).
	maxTimelineReads = 8
	// maxTimelinePages bounds the pages read from one pull request's timeline.
	maxTimelinePages = 10

	// Forgejo's names for the timeline events a scheduled merge leaves, from
	// commentStrings in models/issues/comment.go (CommentTypePRScheduledToAutoMerge
	// and CommentTypePRUnScheduledToAutoMerge).
	eventScheduledMerge       = "pull_scheduled_merge"
	eventCancelScheduledMerge = "pull_cancel_scheduled_merge"
)

// cachedSchedule is what the last successful timeline read said about one pull
// request, and when (a counter, not a clock) so the oldest is read first.
type cachedSchedule struct {
	scheduled bool
	seq       uint64
}

// scheduledMerge reads one pull request's timeline and reports whether a merge
// is scheduled on the forge: true when the latest of the schedule and cancel
// events is the schedule, false when it is the cancel or neither ever happened.
func (c *Client) scheduledMerge(ctx context.Context, owner, name string, number int64) (bool, error) {
	c.setContext(ctx)

	scheduled := false
	for page := 1; page <= maxTimelinePages; page++ {
		path := fmt.Sprintf("/repos/%s/%s/issues/%d/timeline?page=%d&limit=%d", owner, name, number, page, pageLimit)
		slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
		body, resp, err := c.rawRequest(ctx, http.MethodGet, path, nil)
		if err != nil {
			return false, c.forgejoError(ctx, http.MethodGet, path, resp, err)
		}
		var events []struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(body, &events); err != nil {
			return false, fmt.Errorf("forgejo: unmarshal timeline response: %w", err)
		}
		for _, e := range events {
			switch e.Type {
			case eventScheduledMerge:
				scheduled = true
			case eventCancelScheduledMerge:
				scheduled = false
			}
		}
		if len(events) < pageLimit {
			break
		}
	}

	return scheduled, nil
}

// applyScheduledMerges sets AutoMergeEnabled on owner/name's pull requests from
// their timelines. Only a pull request that isn't a draft or empty is read, at
// most maxTimelineReads per call, least recently read first. A pull request not
// read, or whose read failed, gets its last known value, or stays nil (unknown).
func (c *Client) applyScheduledMerges(ctx context.Context, owner, name string, prs []dashboard.PullRequest) {
	var eligible []int
	for i, pr := range prs {
		if !pr.Draft && !pr.Empty {
			eligible = append(eligible, i)
		}
	}

	c.scheduleMu.Lock()
	sort.SliceStable(eligible, func(a, b int) bool {
		return c.schedule[reviewKey(owner, name, int64(prs[eligible[a]].Number))].seq <
			c.schedule[reviewKey(owner, name, int64(prs[eligible[b]].Number))].seq
	})
	c.scheduleMu.Unlock()
	if len(eligible) > maxTimelineReads {
		eligible = eligible[:maxTimelineReads]
	}

	reads := make([]*bool, len(prs))
	var wg sync.WaitGroup
	for _, i := range eligible {
		wg.Add(1)
		go func() {
			defer wg.Done()
			scheduled, err := c.scheduledMerge(ctx, owner, name, int64(prs[i].Number))
			if err != nil {
				slog.Debug("forgejo timeline unavailable", "repo", owner+"/"+name, "pr", prs[i].Number, "err", err)

				return
			}
			reads[i] = &scheduled
		}()
	}
	wg.Wait()

	c.scheduleMu.Lock()
	defer c.scheduleMu.Unlock()
	for _, i := range eligible {
		if reads[i] != nil {
			c.scheduleSeq++
			c.schedule[reviewKey(owner, name, int64(prs[i].Number))] = cachedSchedule{scheduled: *reads[i], seq: c.scheduleSeq}
		}
	}
	for i := range prs {
		if prs[i].Draft || prs[i].Empty {
			continue
		}
		if known, ok := c.schedule[reviewKey(owner, name, int64(prs[i].Number))]; ok {
			on := known.scheduled
			prs[i].AutoMergeEnabled = &on
		}
	}
}

// pruneSchedules drops the cached schedule of owner/name's pull requests that
// are no longer open. open holds the keys the latest complete listing returned.
func (c *Client) pruneSchedules(owner, name string, open map[string]struct{}) {
	prefix := fmt.Sprintf("%s/%s#", owner, name)

	c.scheduleMu.Lock()
	defer c.scheduleMu.Unlock()
	for key := range c.schedule {
		if _, ok := open[key]; !ok && strings.HasPrefix(key, prefix) {
			delete(c.schedule, key)
		}
	}
}

// DisableAutoMerge implements dashboard.PullRequestAutoMergeDisabler: it cancels
// a merge scheduled on the forge (DELETE /repos/{o}/{r}/pulls/{n}/merge). A
// pull request with nothing scheduled answers 404 or 409, which is the state
// the caller wanted, so neither is an error.
func (c *Client) DisableAutoMerge(ctx context.Context, owner, name string, number int) error {
	c.setContext(ctx)

	path := fmt.Sprintf("/repos/%s/%s/pulls/%d/merge", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodDelete, "url", path)
	resp, err := c.sdk.CancelScheduledAutoMerge(owner, name, int64(number))
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusConflict) {
			c.recordRequest(ctx, http.MethodDelete, path, resp.StatusCode, "success")

			return nil
		}

		return c.forgejoError(ctx, http.MethodDelete, path, resp, err)
	}
	c.recordRequest(ctx, http.MethodDelete, path, resp.StatusCode, "success")

	return nil
}
