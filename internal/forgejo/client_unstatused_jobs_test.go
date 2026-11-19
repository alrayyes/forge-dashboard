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
