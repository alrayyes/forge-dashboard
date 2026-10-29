package forgejo

import (
	"context"
	"fmt"
	"time"

	"code.gitea.io/sdk/gitea"
)

// readRunJobs reads the jobs of a run, keeping the list of a finished run (see
// finishedJobs) so a repeat poll costs nothing. A run still going, or one with
// no stop time of its own, is read each time.
//
// A rerun keeps the run's id and stop time and moves its start, so the start is
// part of the key: a kept list is never served for a rerun.
//
// A list is kept only once it is final. An empty list for a run that just
// finished may be the forge catching up, so it is read again until the run is
// older than jobsCatchUp. A list with a job still going is read again too,
// since the jobs may have been read before the forge caught up and a kept list
// would show that job running for as long as we live. A run that failed or was
// cancelled can leave a job queued for good, so once the forge has had
// jobsCatchUp to settle, its list is final too.
func (c *Client) readRunJobs(ctx context.Context, owner, name string, runID int64, status string, started, stopped time.Time) ([]*gitea.ActionWorkflowJob, error) {
	jobs, _, err := c.readWholeRunJobs(ctx, owner, name, runID, status, started, stopped)

	return jobs, err
}

// readWholeRunJobs is readRunJobs that also says whether the list is whole. A
// kept list always is, since only a whole list is kept.
func (c *Client) readWholeRunJobs(ctx context.Context, owner, name string, runID int64, status string, started, stopped time.Time) ([]*gitea.ActionWorkflowJob, bool, error) {
	return c.keepJobs(status, jobsKey(owner, name, runID, started, stopped, 0), stopped, func() ([]*gitea.ActionWorkflowJob, bool, error) {
		return c.walkActionRunJobs(ctx, owner, name, runID)
	})
}

// readRunJobsPage is readRunJobs for the one page of a run's jobs, counted from
// 1, kept the same way. A status names its job's position, so the page holding
// it is all that is read.
func (c *Client) readRunJobsPage(ctx context.Context, owner, name string, runID int64, status string, started, stopped time.Time, page int) ([]*gitea.ActionWorkflowJob, error) {
	jobs, _, err := c.keepJobs(status, jobsKey(owner, name, runID, started, stopped, page), stopped, func() ([]*gitea.ActionWorkflowJob, bool, error) {
		jobs, _, err := c.listActionRunJobsPage(ctx, owner, name, runID, page)

		return jobs, true, err
	})

	return jobs, err
}

// jobsKey names the kept jobs of a run, or of one page of them when page is
// above 0.
func jobsKey(owner, name string, runID int64, started, stopped time.Time, page int) string {
	key := fmt.Sprintf("%s/%s/%d/%s/%s", owner, name, runID, started.Format(time.RFC3339Nano), stopped.Format(time.RFC3339Nano))
	if page > 0 {
		key += fmt.Sprintf("/page/%d", page)
	}

	return key
}

// keepJobs reads jobs with read, and keeps them under key once they are final
// (see readRunJobs). A list that read says is not whole is never kept: it is
// what the forge showed, and a kept one would stand in for the rest for good.
func (c *Client) keepJobs(status, key string, stopped time.Time, read func() ([]*gitea.ActionWorkflowJob, bool, error)) ([]*gitea.ActionWorkflowJob, bool, error) {
	if stopped.IsZero() || !isFinished(status) {
		return read()
	}
	if cached, ok := c.finishedJobs.get(key); ok {
		return cached, true, nil
	}
	jobs, whole, err := read()
	if err != nil {
		return nil, false, err
	}
	settled := time.Since(stopped) > jobsCatchUp
	_, _, over := jobsOutcome(jobs)
	final := whole && (over || (!isPassing(status) && settled))
	if final && (len(jobs) > 0 || settled) {
		c.finishedJobs.put(key, jobs)
	}

	return jobs, whole, nil
}
