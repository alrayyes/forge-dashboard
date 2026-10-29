package forgejo_test

import (
	"encoding/json"
	"os"
	"testing"

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

// The facts are the lists the counts were worked out from, already in memory,
// so a row costs the same requests with them.
func TestReadMainBranch_RunFactsCostNoRequest(t *testing.T) {
	t.Parallel()

	s := runFactsServer()
	client := s.start(t)

	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.ElementsMatch(t, []string{
		"/api/v1/repos/alrayyes/a/actions/runs",
		"/api/v1/repos/alrayyes/a/actions/runs/2/jobs",
		"/api/v1/repos/alrayyes/a/actions/runs/1/jobs",
	}, s.requests())
}

// A repository with no run has none to send.
func TestReadMainBranch_NoRunSendsNoRunFacts(t *testing.T) {
	t.Parallel()

	client := (&mainBranchServer{}).start(t)

	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	assert.Empty(t, row.Runs)
}
