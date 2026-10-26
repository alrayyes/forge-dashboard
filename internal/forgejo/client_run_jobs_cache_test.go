package forgejo_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A failed run can leave a job queued for good. Its jobs are kept only once the
// forge has had jobsCatchUp (five minutes) to settle, so a poll sooner reads
// them again and a poll later reads them once.

// failedWithQueuedJob is a commit whose run 12 failed at stopped and left its
// only job queued.
func failedWithQueuedJob(stopped time.Time) forge {
	f := cancelledPassing("queued")
	f.runs[1] = actionsRun(12, 2, "failure", map[string]any{"stopped": stopped.UTC().Format(time.RFC3339Nano)})

	return f
}

func TestListOpenPullRequests_AFailedRunsQueuedJobIsReadAgainWithinTheCatchUpWindow(t *testing.T) {
	t.Parallel()
	s := failedWithQueuedJob(time.Now().Add(-time.Minute)).serve(t)

	s.pullRequest(t)
	s.pullRequest(t)

	// Only run 12 holds a failed status, so only its list is read.
	assert.EqualValues(t, 2, s.jobReads.Load())
}

func TestListOpenPullRequests_AFailedRunsQueuedJobIsReadOnceAfterTheCatchUpWindow(t *testing.T) {
	t.Parallel()
	s := failedWithQueuedJob(time.Now().Add(-10 * time.Minute)).serve(t)

	s.pullRequest(t)
	s.pullRequest(t)

	assert.EqualValues(t, 1, s.jobReads.Load())
}

// A run the forge gives no stop time can't be told from one still settling, so
// its jobs are read on every poll.
func TestListOpenPullRequests_ARunWithNoStopTimeIsReadOnEveryPoll(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.runs[1] = actionsRun(12, 2, "cancelled", map[string]any{"stopped": nil})
	s := f.serve(t)

	s.pullRequest(t)
	s.pullRequest(t)

	assert.EqualValues(t, 2, s.jobReads.Load())
}

// The run lists fewer jobs than the status's position: nothing there to excuse
// it, so the failure stands.
func TestListOpenPullRequests_AFailureWhosePositionIsPastTheJobsReadStaysFailed(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "pr-title / check (pull_request_target)", 2, 5)

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}
