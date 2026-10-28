package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A job whose needs failed never starts: Forgejo leaves it blocked in a run
// that has already finished, and says pending for it. That is not a wait, so
// the row must not count it as one, or draw a failed pill as still running
// (forge-board-cloud-api#121, run 455: test and lint failed, seven jobs behind
// them blocked).

// blockedBehindFailures is a finished run 455 whose test failed and whose
// build is blocked behind it, beside one passed job of a finished run 456.
func blockedBehindFailures(runStatus string) forge {
	return forge{
		statuses: []map[string]string{
			jobStatus("success", "gitleaks / secrets (pull_request)", 456, 0),
			jobStatus("failure", "ci / test (pull_request)", 455, 0),
			jobStatus("pending", "ci / build (pull_request)", 455, 1),
			jobStatus("pending", "ci / ci result (pull_request)", 455, 2),
		},
		runs: []map[string]any{actionsRun(18784, 456, "success", nil), actionsRun(18783, 455, runStatus, nil)},
		jobs: map[int][]string{18784: {"success"}, 18783: {"failure", "blocked", "blocked"}},
	}
}

func TestListOpenPullRequests_JobsBlockedInAFinishedRunAreNotWaiting(t *testing.T) {
	t.Parallel()

	got := blockedBehindFailures("failure").pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

func TestListOpenPullRequests_JobsBlockedInAFinishedRunStillFailTheRow(t *testing.T) {
	t.Parallel()

	got := blockedBehindFailures("failure").pullRequest(t)

	assert.Equal(t, dashboard.CIFailure, got.CI)
}

// A rerun that is queued or going can still start its jobs, so its pending
// ones are waits.
func TestListOpenPullRequests_JobsBlockedInARunThatIsStillGoingStayWaiting(t *testing.T) {
	t.Parallel()

	got := blockedBehindFailures("waiting").pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Waiting: 2, Failed: 1}, got.Checks)
}

// Only a failure that stands explains a blocked job. Without one the wait is
// left as the forge reports it.
func TestListOpenPullRequests_ABlockedJobWithNoFailureBesideItStaysWaiting(t *testing.T) {
	t.Parallel()
	f := blockedBehindFailures("success")
	f.statuses[1] = jobStatus("success", "ci / test (pull_request)", 455, 0)
	f.jobs[18783] = []string{"success", "blocked", "blocked"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 2, Waiting: 2}, got.Checks)
}

// An external CI's pending status names no run, so it is a wait whatever the
// runs beside it did.
func TestListOpenPullRequests_APendingStatusOfNoRunStaysWaiting(t *testing.T) {
	t.Parallel()
	f := blockedBehindFailures("failure")
	f.statuses = append(f.statuses, map[string]string{"status": "pending", "context": "deploy / build (push)"})

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Waiting: 1, Failed: 1}, got.Checks)
}

// Only a run that failed explains a blocked job. One that was cancelled has had
// its failure excused, and its pending jobs stay waiting, the safe way round.
func TestListOpenPullRequests_JobsBlockedInACancelledRunStayWaiting(t *testing.T) {
	t.Parallel()
	f := blockedBehindFailures("cancelled")
	f.jobs[18783] = []string{"cancelled", "blocked", "blocked"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Waiting: 2}, got.Checks)
}

// Of several finished runs, only the failed one's blocked jobs are no wait.
func TestListOpenPullRequests_OnlyTheFailedRunsBlockedJobsAreNoWait(t *testing.T) {
	t.Parallel()
	f := blockedBehindFailures("failure")
	f.statuses = append(f.statuses,
		jobStatus("success", "lint / lint (pull_request)", 457, 0),
		jobStatus("pending", "lint / report (pull_request)", 457, 1),
	)
	f.runs = append(f.runs, actionsRun(18785, 457, "success", nil))
	f.jobs[18785] = []string{"success", "blocked"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 2, Waiting: 1, Failed: 1}, got.Checks)
}

// A status list the forge cut short is counted as nothing, blocked jobs too.
func TestListOpenPullRequests_ACappedStatusListStaysUncounted(t *testing.T) {
	t.Parallel()
	f := blockedBehindFailures("failure")
	f.totalCount = 40

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{}, got.Checks)
}
