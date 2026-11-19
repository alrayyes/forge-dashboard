package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// Forgejo writes a commit status for a job only once the job has one to give,
// so a pull request that has just opened has statuses for the jobs that have
// started and none yet for the ones still queued behind them (#4238). The
// pipeline dialog lists every job, so the row's counts must too: otherwise the
// Waiting segment turns up a minute later, when the statuses do.
func TestListOpenPullRequests_AQueuedJobWithNoStatusYetStillCountsAsWaiting(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("skipped", "ci / label (pull_request)", 2, 0),
			jobStatus("pending", "ci / lint (pull_request)", 2, 1),
		},
		runs: []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs: map[int][]string{12: {"skipped", "running", "blocked", "waiting"}},
		// The combined state reads pending while a job runs.
		state: "pending",
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Skipped: 1, Running: 1, Waiting: 2}, got.Checks)
}

// A job that has a status is counted from it, never twice.
func TestListOpenPullRequests_AQueuedJobWithAStatusIsNotCountedTwice(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("pending", "ci / lint (pull_request)", 2, 0),
			jobStatus("pending", "ci / test (pull_request)", 2, 1),
		},
		runs:  []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:  map[int][]string{12: {"running", "waiting"}},
		state: "pending",
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Running: 1, Waiting: 1}, got.Checks)
}

// A push run and a pull request run of one commit run the same jobs, and the
// statuses come from the pull request's. Reading the push run's jobs too would
// count each of them twice.
func TestListOpenPullRequests_APushRunShadowedByAPullRequestRunIsNotCounted(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("pending", "ci / lint (pull_request)", 2, 0),
			jobStatus("pending", "ci / lint (push)", 3, 0),
		},
		runs: []map[string]any{
			actionsRun(12, 2, "running", nil),
			actionsRun(13, 3, "running", map[string]any{"event": "push"}),
		},
		jobs:  map[int][]string{12: {"running", "waiting"}, 13: {"running", "waiting"}},
		state: "pending",
	}

	got := f.pullRequest(t)

	// Only the pull request run's unstatused job is added.
	assert.Equal(t, dashboard.CheckCounts{Running: 1, Waiting: 2}, got.Checks)
}

// A job in a state this code has no name for, and with no status yet, is still
// a job the pipeline dialog lists. It lands in Unknown rather than vanishing.
func TestListOpenPullRequests_AnUnnamedJobStateWithNoStatusYetCountsAsUnknown(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:     map[int][]string{12: {"running", "brand_new_state"}},
		state:    "pending",
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Running: 1, Unknown: 1}, got.Checks)
}

// A run that is going can have every job that started finished and the rest
// still queued, with no status for them yet. The statuses read success then,
// and the row must still count the queued jobs and read pending (#4252).
func TestListOpenPullRequests_FinishedStatusesOfARunningRunStillCountItsQueuedJobs(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("success", "ci / lint (pull_request)", 2, 0),
			jobStatus("success", "ci / test (pull_request)", 2, 1),
		},
		runs:  []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:  map[int][]string{12: {"success", "success", "waiting", "waiting"}},
		state: "success",
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 2, Waiting: 2}, got.Checks)
	assert.Equal(t, dashboard.CIPending, got.CI)
}

// A pull request that has no statuses yet is still read against its runs.
func TestListOpenPullRequests_ARowWithNoStatusesStillCountsTheQueuedJobsOfARunningRun(t *testing.T) {
	t.Parallel()

	f := forge{
		runs:  []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:  map[int][]string{12: {"waiting", "waiting"}},
		state: "pending",
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Waiting: 2}, got.Checks)
	assert.Equal(t, dashboard.CIPending, got.CI)
}

// A row whose checks are all done reads the runs of its commit, one request,
// and no job of a finished run: that is the whole cost of the check.
func TestListOpenPullRequests_ASettledRowReadsTheRunsButNoJobs(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("success", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "success", nil)},
		jobs:     map[int][]string{12: {"success"}},
		state:    "success",
	}
	s := f.serve(t)

	got := s.pullRequest(t)

	assert.Equal(t, dashboard.CISuccess, got.CI)
	assert.Equal(t, int32(1), s.runReads.Load())
	assert.Equal(t, int32(0), s.jobReads.Load())
}

// A running run's jobs are read once for the row, however many of the row's
// questions need them.
func TestListOpenPullRequests_ARunningRunsJobsAreReadOncePerRow(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("success", "ci / lint (pull_request)", 2, 0),
			jobStatus("pending", "ci / test (pull_request)", 2, 1),
		},
		runs:  []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:  map[int][]string{12: {"success", "running", "waiting"}},
		state: "pending",
	}
	s := f.serve(t)

	s.pullRequest(t)

	assert.Equal(t, int32(1), s.jobReads.Load())
}
