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
	if stopped.IsZero() || !isFinished(status) {
		return c.listActionRunJobs(ctx, owner, name, runID)
	}
	key := fmt.Sprintf("%s/%s/%d/%s/%s", owner, name, runID, started.Format(time.RFC3339Nano), stopped.Format(time.RFC3339Nano))
	if cached, ok := c.finishedJobs.get(key); ok {
		return cached, nil
	}
	jobs, err := c.listActionRunJobs(ctx, owner, name, runID)
	if err != nil {
		return nil, err
	}
	settled := time.Since(stopped) > jobsCatchUp
	_, _, over := jobsOutcome(jobs)
	final := over || (!isPassing(status) && settled)
	if final && (len(jobs) > 0 || settled) {
		c.finishedJobs.put(key, jobs)
	}

	return jobs, nil
}
