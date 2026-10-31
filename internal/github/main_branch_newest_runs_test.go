package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const runsURL = "https://github.com/alrayyes/a/actions/runs/"

// suiteNode is a check suite of the commit as the default-branch query reads it.
func suiteNode(id, status, conclusion string, run map[string]any) map[string]any {
	node := map[string]any{"id": id, "status": status, "workflowRun": run}
	if conclusion != "" {
		node["conclusion"] = conclusion
	}

	return node
}

// fetchNewest reads the default branch of one repo whose commit carries the
// rollup and the check suites given. later answers the follow-up read of the
// check runs of the suites the rollup left out, keyed by suite id.
func fetchNewest(t *testing.T, rollup map[string]any, suites []map[string]any, later map[string][]map[string]any) dashboard.MainBranch {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		body := readGraphQLRequest(t, r)
		if strings.Contains(body.Query, "nodes(ids") {
			nodes := []map[string]any{}
			for id, runs := range later {
				nodes = append(nodes, map[string]any{"id": id, "checkRuns": map[string]any{"nodes": runs}})
			}
			writeJSON(t, w, map[string]any{"data": map[string]any{"nodes": nodes}})

			return
		}
		ref := branchRef(rollup)
		ref["target"].(map[string]any)["checkSuites"] = map[string]any{"nodes": suites}
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
			"url": "https://github.com/alrayyes/a", "defaultBranchRef": ref,
		}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	row, err := github.NewClient("test-token", "", srv.URL).FetchMainBranch(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)

	return row
}

// The rollup holds the push run's failed job and none of the dispatched run
// that passed after it: the row has to read the newer run.
func TestFetchMainBranch_ANewerRunMissingFromTheRollupClearsTheFailure(t *testing.T) {
	t.Parallel()

	push := workflowRun(1, 1, 5, "ci")
	dispatched := workflowRun(2, 1, 6, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "FAILURE": 1},
		runCheck(11, "lint", "COMPLETED", "SUCCESS", "2026-10-26T08:00:00Z", "2026-10-26T08:01:00Z", runsURL+"1/job/11", suiteOf("COMPLETED", "FAILURE", push)),
		runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:02:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", push)),
	)
	suites := []map[string]any{
		suiteNode("S1", "COMPLETED", "FAILURE", push),
		suiteNode("S2", "COMPLETED", "SUCCESS", dispatched),
	}
	later := map[string][]map[string]any{"S2": {
		runCheck(21, "lint", "COMPLETED", "SUCCESS", "2026-10-30T11:42:00Z", "2026-10-30T11:43:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "SUCCESS", dispatched)),
		runCheck(22, "reports", "COMPLETED", "SUCCESS", "2026-10-30T11:43:00Z", "2026-10-30T11:44:00Z", runsURL+"2/job/22", suiteOf("COMPLETED", "SUCCESS", dispatched)),
	}}

	row := fetchNewest(t, rollup, suites, later)

	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2}, row.Checks)
	assert.Empty(t, row.FailingJobs)
	assert.Equal(t, 1, countRuns(row), "only the newest run of ci is sent")
	require.NotNil(t, row.DurationSeconds)
	assert.Equal(t, 120, *row.DurationSeconds, "the duration spans the newest run, not the commit's oldest")
}

func countRuns(row dashboard.MainBranch) int { return len(row.Runs) }

// A newer run still going is the row's status, not the older run's failure.
func TestFetchMainBranch_ANewerRunStillGoingMakesTheRowRunning(t *testing.T) {
	t.Parallel()

	push := workflowRun(1, 1, 5, "ci")
	dispatched := workflowRun(2, 1, 6, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"FAILURE": 1},
		runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:02:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", push)),
	)
	suites := []map[string]any{suiteNode("S1", "COMPLETED", "FAILURE", push), suiteNode("S2", "IN_PROGRESS", "", dispatched)}
	later := map[string][]map[string]any{"S2": {
		runCheck(22, "reports", "IN_PROGRESS", "", "2026-10-30T11:43:00Z", "", runsURL+"2/job/22", suiteOf("IN_PROGRESS", "", dispatched)),
	}}

	row := fetchNewest(t, rollup, suites, later)

	assert.Equal(t, dashboard.MainBranchRunning, row.Status)
}

// Another workflow's failure still fails the row and is named.
func TestFetchMainBranch_AFailureOfAnotherWorkflowStands(t *testing.T) {
	t.Parallel()

	ci := workflowRun(2, 1, 6, "ci")
	deploy := workflowRun(3, 1, 9, "deploy")
	oldCI := workflowRun(1, 1, 5, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "FAILURE": 2},
		runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:02:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", oldCI)),
		runCheck(31, "ship", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:03:00Z", runsURL+"3/job/31", suiteOf("COMPLETED", "FAILURE", deploy)),
		runCheck(22, "reports", "COMPLETED", "SUCCESS", "2026-10-30T11:43:00Z", "2026-10-30T11:44:00Z", runsURL+"2/job/22", suiteOf("COMPLETED", "SUCCESS", ci)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	assert.Equal(t, dashboard.MainBranchFailed, row.Status)
	assert.Equal(t, []string{"ship"}, row.FailingJobs)
}

// A rerun of the same run: attempt 2 replaces attempt 1.
func TestFetchMainBranch_ALaterAttemptOfTheSameRunStillReplacesTheEarlier(t *testing.T) {
	t.Parallel()

	attempt1 := workflowRun(1, 1, 5, "ci")
	attempt2 := workflowRun(1, 2, 5, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "FAILURE": 1},
		runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:02:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", attempt1)),
		runCheck(13, "reports", "COMPLETED", "SUCCESS", "2026-10-26T09:00:00Z", "2026-10-26T09:02:00Z", runsURL+"1/job/13", suiteOf("COMPLETED", "SUCCESS", attempt2)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
}

// Two workflows whose newest runs are days apart: the row says how long the run
// that finished last took, not the span from the oldest start to that finish.
func TestFetchMainBranch_TheDurationIsThatOfTheRunThatFinishedLast(t *testing.T) {
	t.Parallel()

	ci := workflowRun(2, 1, 6, "ci")
	scan := workflowRun(3, 1, 9, "gitleaks")
	rollup := rollupOf("SUCCESS", map[string]int{"SUCCESS": 3},
		runCheck(31, "scan", "COMPLETED", "SUCCESS", "2026-10-26T08:00:00Z", "2026-10-26T08:01:00Z", runsURL+"3/job/31", suiteOf("COMPLETED", "SUCCESS", scan)),
		runCheck(21, "lint", "COMPLETED", "SUCCESS", "2026-10-30T11:42:00Z", "2026-10-30T11:43:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "SUCCESS", ci)),
		runCheck(22, "test", "COMPLETED", "SUCCESS", "2026-10-30T11:43:00Z", "2026-10-30T11:44:00Z", runsURL+"2/job/22", suiteOf("COMPLETED", "SUCCESS", ci)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	require.NotNil(t, row.DurationSeconds)
	assert.Equal(t, 120, *row.DurationSeconds)
}

// A rollup cut short lists part of the newest run; the follow-up read lists the
// whole run again. Each job counts once, and the row says what it still lacks.
func TestFetchMainBranch_AJobTheRollupAndTheFollowUpBothListCountsOnce(t *testing.T) {
	t.Parallel()

	run := workflowRun(2, 1, 6, "ci")
	suite := suiteOf("COMPLETED", "SUCCESS", run)
	job := func(id int, name string) map[string]any {
		return runCheck(id, name, "COMPLETED", "SUCCESS", "2026-10-30T11:42:00Z", "2026-10-30T11:43:00Z", runsURL+"2/job/"+name, suite)
	}
	rollup := rollupOf("SUCCESS", map[string]int{"SUCCESS": 5}, job(21, "lint"), job(22, "test"))
	suites := []map[string]any{suiteNode("S2", "COMPLETED", "SUCCESS", run)}
	later := map[string][]map[string]any{"S2": {job(21, "lint"), job(22, "test"), job(23, "build")}}

	row := fetchNewest(t, rollup, suites, later)

	require.Len(t, row.Runs, 1)
	assert.Len(t, row.Runs[0].Checks, 3, "a job is listed once")
	assert.Equal(t, 3, row.Checks.Passed, "a job is counted once")
	assert.True(t, row.Runs[0].JobsTruncated, "the commit has two more checks than were read")
}

// A commit whose newest run was read whole is not cut short.
func TestFetchMainBranch_ANewestRunReadWholeIsNotTruncated(t *testing.T) {
	t.Parallel()

	push := workflowRun(1, 1, 5, "ci")
	dispatched := workflowRun(2, 1, 6, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"FAILURE": 1},
		runCheck(12, "reports", "COMPLETED", "FAILURE", "2026-10-26T08:00:00Z", "2026-10-26T08:02:00Z", runsURL+"1/job/12", suiteOf("COMPLETED", "FAILURE", push)),
	)
	suites := []map[string]any{suiteNode("S1", "COMPLETED", "FAILURE", push), suiteNode("S2", "COMPLETED", "SUCCESS", dispatched)}
	later := map[string][]map[string]any{"S2": {
		runCheck(22, "reports", "COMPLETED", "SUCCESS", "2026-10-30T11:43:00Z", "2026-10-30T11:44:00Z", runsURL+"2/job/22", suiteOf("COMPLETED", "SUCCESS", dispatched)),
	}}

	row := fetchNewest(t, rollup, suites, later)

	require.Len(t, row.Runs, 1)
	assert.False(t, row.Runs[0].JobsTruncated)
}

// The rollup counts four checks and lists two; the follow-up read adds two. The
// read jobs make up the shortfall, but they came from a suite, not from the
// rollup, so the rollup is still cut short and the row says so.
func TestFetchMainBranch_AShortfallMadeUpByTheFollowUpStillReadsAsTruncated(t *testing.T) {
	t.Parallel()

	run := workflowRun(2, 1, 6, "ci")
	suite := suiteOf("COMPLETED", "SUCCESS", run)
	job := func(id int, name string) map[string]any {
		return runCheck(id, name, "COMPLETED", "SUCCESS", "2026-10-30T11:42:00Z", "2026-10-30T11:43:00Z", runsURL+"2/job/"+name, suite)
	}
	rollup := rollupOf("SUCCESS", map[string]int{"SUCCESS": 4}, job(21, "lint"), job(22, "test"))
	suites := []map[string]any{suiteNode("S2", "COMPLETED", "SUCCESS", run)}
	later := map[string][]map[string]any{"S2": {job(23, "build"), job(24, "deploy")}}

	row := fetchNewest(t, rollup, suites, later)

	require.Len(t, row.Runs, 1)
	assert.Equal(t, 4, row.Checks.Passed)
	assert.True(t, row.Runs[0].JobsTruncated, "the rollup listed two of its four checks")
}

// A newest run that was only cancelled replaces nothing: the older run's pass
// stands and the row reads cancelled, not failed, as the page's fold does.
func TestFetchMainBranch_ACancelledNewestRunLeavesTheRowCancelledNotFailed(t *testing.T) {
	t.Parallel()

	older := workflowRun(1, 1, 5, "ci")
	newest := workflowRun(2, 1, 6, "ci")
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "CANCELLED": 1},
		runCheck(11, "lint", "COMPLETED", "SUCCESS", "2026-10-26T08:00:00Z", "2026-10-26T08:01:00Z", runsURL+"1/job/11", suiteOf("COMPLETED", "SUCCESS", older)),
		runCheck(21, "lint", "COMPLETED", "CANCELLED", "2026-10-30T11:42:00Z", "2026-10-30T11:43:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "CANCELLED", newest)),
	)
	suites := []map[string]any{suiteNode("S1", "COMPLETED", "SUCCESS", older), suiteNode("S2", "COMPLETED", "CANCELLED", newest)}

	row := fetchNewest(t, rollup, suites, nil)

	assert.Equal(t, dashboard.MainBranchCancelled, row.Status)
	assert.Empty(t, row.FailingJobs)
	assert.Equal(t, 0, row.Checks.Failed)
}

// Dependabot Updates runs (event "dynamic") start several at once on the default
// branch. One failing is not the branch failing (#3125).
func TestFetchMainBranch_AFailedDependabotUpdateRunDoesNotFailTheRow(t *testing.T) {
	t.Parallel()

	ci := workflowRun(1, 1, 5, "ci")
	update := workflowRun(2, 1, 6, "Dependabot Updates")
	update["event"] = "dynamic"
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "FAILURE": 1},
		runCheck(11, "lint", "COMPLETED", "SUCCESS", "2026-10-31T00:30:00Z", "2026-10-31T00:31:00Z", runsURL+"1/job/11", suiteOf("COMPLETED", "SUCCESS", ci)),
		runCheck(21, "Dependabot", "COMPLETED", "FAILURE", "2026-10-31T00:32:00Z", "2026-10-31T00:33:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "FAILURE", update)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
}

// A head commit carrying only Dependabot Updates runs has no CI of its own: the
// row must not read it as a pass with no checks (#3125).
func TestFetchMainBranch_ACommitWithOnlyDependabotUpdateRunsHasNoCI(t *testing.T) {
	t.Parallel()

	update := workflowRun(2, 1, 6, "Dependabot Updates")
	update["event"] = "dynamic"
	rollup := rollupOf("PENDING", map[string]int{"IN_PROGRESS": 1},
		runCheck(21, "Dependabot", "IN_PROGRESS", "", "2026-10-31T00:32:00Z", "", runsURL+"2/job/21", suiteOf("IN_PROGRESS", "", update)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	assert.Equal(t, dashboard.MainBranchNone, row.Status)
}

func TestFetchMainBranch_ADependabotUpdateRunIsNotCountedAmongTheChecks(t *testing.T) {
	t.Parallel()

	ci := workflowRun(1, 1, 5, "ci")
	update := workflowRun(2, 1, 6, "Dependabot Updates")
	update["event"] = "dynamic"
	rollup := rollupOf("FAILURE", map[string]int{"SUCCESS": 1, "FAILURE": 1},
		runCheck(11, "lint", "COMPLETED", "SUCCESS", "2026-10-31T00:30:00Z", "2026-10-31T00:31:00Z", runsURL+"1/job/11", suiteOf("COMPLETED", "SUCCESS", ci)),
		runCheck(21, "Dependabot", "COMPLETED", "FAILURE", "2026-10-31T00:32:00Z", "2026-10-31T00:33:00Z", runsURL+"2/job/21", suiteOf("COMPLETED", "FAILURE", update)),
	)

	row := fetchNewest(t, rollup, nil, nil)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, row.Checks)
}
