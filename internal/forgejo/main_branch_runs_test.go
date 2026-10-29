package forgejo_test

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runFactsFixture is what the page's foldBranch test reads too
// (web/src/lib/main-branch-runs.test.ts): the row the server sends, so the
// page's fold is checked against the status and counts the server worked out
// from the same runs, not against a copy of the rule.
const runFactsFixture = "../../web/src/lib/testdata/main-branch-runs.json"

func runFactsServer() *mainBranchServer {
	job := func(id int, name, status string, attempt int) map[string]any {
		return map[string]any{
			"id": id, "name": name, "status": status, "run_attempt": attempt,
			"html_url":   "https://forge.example/alrayyes/a/actions/runs/1/jobs/" + name,
			"started_at": started,
		}
	}

	return &mainBranchServer{
		commit: goodCommit(),
		runs: []map[string]any{
			actionRun(2, "main", "cafef00d", "running", started, unset),
			actionRun(1, "main", "cafef00d", "failure", started, stopped),
		},
		jobs: map[string][]map[string]any{
			"2": {job(21, "e2e", "running", 2), job(22, "deploy", "waiting", 2)},
			"1": {job(11, "lint", "success", 1), job(12, "unit", "failure", 1), job(13, "docs", "skipped", 1)},
		},
	}
}

// The row carries the runs and jobs it counted, so a page can fold them itself.
func TestReadMainBranch_CarriesTheRunFactsItCounted(t *testing.T) {
	t.Parallel()

	client := runFactsServer().start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	got := map[string]any{"status": row.Status, "checks": row.Checks, "runs": row.Runs}
	raw, err := json.Marshal(got)
	require.NoError(t, err)
	want, err := os.ReadFile(runFactsFixture)
	require.NoError(t, err)
	assert.JSONEq(t, string(want), string(raw))
}

// cutShortFixture is the row for a run whose job list the forge cut short,
// which web/src/lib/main-branch-runs.test.ts folds too.
const cutShortFixture = "../../web/src/lib/testdata/main-branch-runs-cut-short.json"

// A run whose job list is cut short says so. The listed jobs are all green, but
// the run is failed and the server won't call it over from a part of its jobs.
func TestReadMainBranch_SaysWhenARunsJobsAreCutShort(t *testing.T) {
	t.Parallel()

	srv := runFactsServer()
	srv.runs = srv.runs[1:]
	srv.jobs = map[string][]map[string]any{"1": {
		{"id": 11, "name": "lint", "status": "success", "run_attempt": 1, "started_at": started},
		{"id": 12, "name": "unit", "status": "success", "run_attempt": 1, "started_at": started},
	}}
	srv.jobsTotal = map[string]int{"1": 40}
	client := srv.start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	got := map[string]any{"status": row.Status, "checks": row.Checks, "runs": row.Runs}
	raw, err := json.Marshal(got)
	require.NoError(t, err)
	want, err := os.ReadFile(cutShortFixture)
	require.NoError(t, err)
	assert.JSONEq(t, string(want), string(raw))
}

// The facts are the lists the counts were worked out from, already in memory,
// so a row costs the same requests with them. Every route is counted, not only
// the runs and the jobs.
func TestReadMainBranch_RunFactsCostNoRequest(t *testing.T) {
	t.Parallel()

	s := runFactsServer()
	client := s.start(t)

	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.ElementsMatch(t, []string{
		"/api/v1/repos/alrayyes/a/git/commits/cafef00d",
		"/api/v1/repos/alrayyes/a/actions/runs",
		"/api/v1/repos/alrayyes/a/actions/runs/2/jobs",
		"/api/v1/repos/alrayyes/a/actions/runs/1/jobs",
	}, s.everyRequest())
}

// A repository with no run has none to send.
func TestReadMainBranch_NoRunSendsNoRunFacts(t *testing.T) {
	t.Parallel()

	client := (&mainBranchServer{}).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	raw, err := json.Marshal(row)
	require.NoError(t, err)
	var wire map[string]any
	require.NoError(t, json.Unmarshal(raw, &wire))
	assert.NotContains(t, wire, "runs")
}

// A run that was only cancelled keeps its conclusion in the facts, so a page
// can tell it from a failure.
func TestReadMainBranch_CancelledOnlyRunSendsItsConclusion(t *testing.T) {
	t.Parallel()

	client := (&mainBranchServer{
		commit: goodCommit(),
		runs:   []map[string]any{actionRun(1, "main", "cafef00d", "cancelled", started, stopped)},
		jobs: map[string][]map[string]any{
			"1": {{"id": 11, "name": "unit", "status": "cancelled", "run_attempt": 1, "started_at": started}},
		},
	}).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	require.Len(t, row.Runs, 1)
	assert.Equal(t, dashboard.CheckConclusion("cancelled"), row.Runs[0].Conclusion)
}

// A job Forgejo holds back in a run that can still go is a wait, and the
// facts say queued, not running.
func TestReadMainBranch_HeldJobSendsAsQueued(t *testing.T) {
	t.Parallel()

	client := (&mainBranchServer{
		commit: goodCommit(),
		runs:   []map[string]any{actionRun(1, "main", "cafef00d", "running", started, unset)},
		jobs: map[string][]map[string]any{
			"1": {{"id": 11, "name": "deploy", "status": "blocked", "run_attempt": 1, "started_at": started}},
		},
	}).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	require.Len(t, row.Runs, 1)
	require.Len(t, row.Runs[0].Checks, 1)
	assert.Equal(t, dashboard.CheckStatus("queued"), row.Runs[0].Checks[0].Status)
}
