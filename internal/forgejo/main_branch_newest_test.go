package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// numbered is a run of the workflow file with Forgejo's per-repo run number.
func numbered(id, number int, workflow, status string) map[string]any {
	run := actionRun(id, "main", "cafef00d", status, started, stopped)
	run["index_in_repo"] = number
	run["workflow_id"] = workflow + ".yaml@refs/heads/main"

	return run
}

func jobOf(id int, name, status string) map[string]any {
	return map[string]any{"id": id, "name": name, "status": status, "run_attempt": 1, "started_at": started}
}

func newestServer(runs ...map[string]any) *mainBranchServer {
	return &mainBranchServer{
		commit: goodCommit(),
		runs:   runs,
		jobs: map[string][]map[string]any{
			"1": {jobOf(11, "unit", "failure"), jobOf(12, "lint", "success")},
			"2": {jobOf(21, "unit", "success"), jobOf(22, "lint", "success"), jobOf(23, "docs", "success")},
			"3": {jobOf(31, "e2e", "failure")},
			"4": {jobOf(41, "unit", "running")},
		},
	}
}

// An older failed run of a workflow no longer fails the row once a newer run of
// it passed, and only the newer run's jobs count.
func TestReadMainBranch_NewerPassingRunClearsAnOlderFailure(t *testing.T) {
	t.Parallel()

	client := newestServer(numbered(2, 2, "ci", "success"), numbered(1, 1, "ci", "failure")).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
	assert.Equal(t, 3, row.Checks.Passed)
	assert.Zero(t, row.Checks.Failed)
	assert.Empty(t, row.FailingJobs)
	require.Len(t, row.Runs, 1)
	assert.Equal(t, int64(2), row.Runs[0].RunID)
}

// A failed run of another workflow still fails the row.
func TestReadMainBranch_FailureOfAnotherWorkflowStillFails(t *testing.T) {
	t.Parallel()

	client := newestServer(
		numbered(3, 3, "e2e", "failure"), numbered(2, 2, "ci", "success"), numbered(1, 1, "ci", "failure"),
	).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	assert.Equal(t, []string{"e2e"}, row.FailingJobs)
}

// A newer run still going reads as running, not as the older failure.
func TestReadMainBranch_NewerRunningRunReplacesAnOlderFailure(t *testing.T) {
	t.Parallel()

	client := newestServer(numbered(4, 4, "ci", "running"), numbered(1, 1, "ci", "failure")).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchRunning, row.Status)
	assert.Zero(t, row.Checks.Failed)
}

// A newer run that was only cancelled replaces nothing: the older failure stands.
func TestReadMainBranch_NewerCancelledRunReplacesNothing(t *testing.T) {
	t.Parallel()

	srv := newestServer(numbered(5, 5, "ci", "cancelled"), numbered(1, 1, "ci", "failure"))
	srv.jobs["5"] = []map[string]any{jobOf(51, "unit", "cancelled")}
	client := srv.start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	assert.Equal(t, []string{"unit"}, row.FailingJobs)
}

// A run with no number (an older Forgejo) is never replaced.
func TestReadMainBranch_RunWithoutANumberIsNeverReplaced(t *testing.T) {
	t.Parallel()

	unnumbered := actionRun(1, "main", "cafef00d", "failure", started, stopped)
	client := newestServer(numbered(2, 2, "ci", "success"), unnumbered).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
}

// A run listed as running whose jobs all ended cancelled is only cancelled, so
// it replaces nothing: the older failure stands, in the row and in the list.
func TestNewestRun_ListedRunningButAllCancelledReplacesNothing(t *testing.T) {
	t.Parallel()

	srv := newestServer(numbered(5, 5, "ci", "running"), numbered(1, 1, "ci", "failure"))
	srv.jobs["5"] = []map[string]any{
		{"id": 51, "name": "unit", "status": "cancelled", "run_attempt": 1, "started_at": started, "completed_at": stopped},
	}
	client := srv.start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	runIDs := map[int64]bool{}
	for _, c := range checks {
		runIDs[c.RunID] = true
	}
	assert.Equal(t, map[int64]bool{1: true, 5: true}, runIDs, "the list keeps the older run too")
}

// Two runs of one workflow with the same number replace neither.
func TestReadMainBranch_RunsWithTheSameNumberReplaceNeitherOther(t *testing.T) {
	t.Parallel()

	client := newestServer(numbered(2, 7, "ci", "success"), numbered(1, 7, "ci", "failure")).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	assert.Len(t, row.Runs, 2)
}

// The dialog's list holds the newest run of each workflow, as the row counts.
func TestListDefaultBranchChecks_KeepsTheNewestRunOfEachWorkflow(t *testing.T) {
	t.Parallel()

	client := newestServer(numbered(2, 2, "ci", "success"), numbered(1, 1, "ci", "failure")).start(t)

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")
	require.NoError(t, err)

	require.Len(t, checks, 3)
	for _, c := range checks {
		assert.Equal(t, int64(2), c.RunID)
	}
}
