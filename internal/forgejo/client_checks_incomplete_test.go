package forgejo_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// While Forgejo has not yet made every job of a run, the row's counts are some
// of the checks, and the server says so rather than leave the counts to look
// final (#4253). It sends the fact; the page words it.

// A running run with no job yet has nothing to count: the list is incomplete.
func TestListOpenPullRequests_ARunningRunWithNoJobsYetIsAnIncompleteCheckList(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:     map[int][]string{12: {}},
		state:    "pending",
	}

	assert.True(t, f.pullRequest(t).ChecksIncomplete)
}

// A running run that no status points at has jobs the counts leave out.
func TestListOpenPullRequests_ARunningRunNoStatusPointsAtIsAnIncompleteCheckList(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{
			jobStatus("pending", "ci / lint (pull_request)", 2, 0),
			jobStatus("pending", "ci / lint (push)", 3, 0),
		},
		runs: []map[string]any{
			actionsRun(12, 2, "running", nil),
			actionsRun(14, 4, "running", map[string]any{"event": "schedule"}),
		},
		jobs:  map[int][]string{12: {"running"}, 14: {"waiting", "waiting"}},
		state: "pending",
	}

	assert.True(t, f.pullRequest(t).ChecksIncomplete)
}

// Every job of every running run is counted, from a status or from the run.
func TestListOpenPullRequests_AListWhereEveryJobIsCountedIsComplete(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:     map[int][]string{12: {"running", "waiting"}},
		state:    "pending",
	}

	assert.False(t, f.pullRequest(t).ChecksIncomplete)
}

// A finished run is a complete list.
func TestListOpenPullRequests_AFinishedRunIsACompleteCheckList(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("failure", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "failure", nil)},
		jobs:     map[int][]string{12: {"failure"}},
		state:    "failure",
	}

	assert.False(t, f.pullRequest(t).ChecksIncomplete)
}

// A pull request just opened has no status at all, and its run has started with
// jobs that no status has caught up with. That is the first read the ticket is
// about.
func TestListOpenPullRequests_ARunningRunWithNoStatusesAtAllIsAnIncompleteCheckList(t *testing.T) {
	t.Parallel()

	for name, jobs := range map[string][]string{"no job yet": {}, "queued jobs": {"waiting", "waiting"}} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			f := forge{
				runs:  []map[string]any{actionsRun(12, 2, "running", nil)},
				jobs:  map[int][]string{12: jobs},
				state: "pending",
			}

			assert.True(t, f.pullRequest(t).ChecksIncomplete)
		})
	}
}

// A finished status beside a second run that is still going and has no status
// yet: the counts are the first run's only.
func TestListOpenPullRequests_ASettledStatusBesideAnUnstatusedRunningRunIsIncomplete(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("success", "ci / lint (pull_request)", 2, 0)},
		runs: []map[string]any{
			actionsRun(12, 2, "success", nil),
			actionsRun(14, 4, "running", map[string]any{"event": "schedule"}),
		},
		jobs:  map[int][]string{12: {"success"}, 14: {"waiting"}},
		state: "success",
	}

	assert.True(t, f.pullRequest(t).ChecksIncomplete)
}

// A push run that a pull request run shadows holds the same jobs, so it is not
// a second list that could be incomplete.
func TestListOpenPullRequests_AShadowedPushRunWithNoJobsIsNotIncomplete(t *testing.T) {
	t.Parallel()

	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / lint (pull_request)", 2, 0)},
		runs: []map[string]any{
			actionsRun(12, 2, "running", nil),
			actionsRun(13, 3, "running", map[string]any{"event": "push"}),
		},
		jobs:  map[int][]string{12: {"running"}, 13: {}},
		state: "pending",
	}

	assert.False(t, f.pullRequest(t).ChecksIncomplete)
}
