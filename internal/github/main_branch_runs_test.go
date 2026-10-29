package github_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// runFactsFixture is what the page's foldBranch test reads too
// (web/src/lib/main-branch-runs.test.ts): the row the server sends, so the
// page's fold is checked against the status and counts the server worked out
// from the same checks, not against a copy of the rule.
const runFactsFixture = "../../web/src/lib/testdata/main-branch-runs-github.json"

// suiteOf is the check suite a check run answers with: the run it belongs to
// (nil for a check app that isn't Actions) and how that suite stands.
func suiteOf(status, conclusion string, run map[string]any) map[string]any {
	suite := map[string]any{"status": status, "workflowRun": run}
	if conclusion != "" {
		suite["conclusion"] = conclusion
	}

	return suite
}

func workflowRun(id, attempt, number int, name string) map[string]any {
	return map[string]any{
		"databaseId": id, "runAttempt": attempt, "runNumber": number,
		"workflow": map[string]any{"name": name},
	}
}

// runCheck is a check run node as the default-branch query reads it.
func runCheck(id int, name, status, conclusion, started, completed, url string, suite map[string]any) map[string]any {
	node := map[string]any{
		"__typename": "CheckRun", "databaseId": id, "name": name, "status": status,
		"startedAt": started, "detailsUrl": url, "checkSuite": suite,
	}
	if conclusion != "" {
		node["conclusion"] = conclusion
	}
	if completed != "" {
		node["completedAt"] = completed
	}

	return node
}

func runFactsRollup() map[string]any {
	ci := workflowRun(1, 1, 5, "ci")
	deploy := workflowRun(2, 2, 6, "deploy")

	return rollupOf("FAILURE", map[string]int{"SUCCESS": 2, "FAILURE": 1, "IN_PROGRESS": 1},
		runCheck(11, "lint", "COMPLETED", "SUCCESS", "2026-10-10T09:01:00Z", "2026-10-10T09:02:00Z",
			"https://github.com/alrayyes/a/actions/runs/1/job/11", suiteOf("COMPLETED", "FAILURE", ci)),
		runCheck(12, "unit", "COMPLETED", "FAILURE", "2026-10-10T09:01:00Z", "2026-10-10T09:05:00Z",
			"https://github.com/alrayyes/a/actions/runs/1/job/12", suiteOf("COMPLETED", "FAILURE", ci)),
		runCheck(21, "e2e", "IN_PROGRESS", "", "2026-10-10T09:03:00Z", "",
			"https://github.com/alrayyes/a/actions/runs/2/job/21", suiteOf("IN_PROGRESS", "", deploy)),
		runCheck(31, "codecov", "COMPLETED", "SUCCESS", "2026-10-10T09:04:00Z", "2026-10-10T09:04:30Z",
			"https://app.codecov.io/gh/alrayyes/a", suiteOf("COMPLETED", "SUCCESS", nil)),
	)
}

// The row carries the runs and checks it counted, so a page can fold them itself.
func TestFetch_MainBranch_CarriesTheRunFactsItCounted(t *testing.T) {
	t.Parallel()

	row, _ := tokenFetchWith(t, branchRef(runFactsRollup()))

	raw, err := json.Marshal(map[string]any{"status": row.Status, "checks": row.Checks, "runs": row.Runs})
	require.NoError(t, err)
	want, err := os.ReadFile(runFactsFixture)
	require.NoError(t, err)
	assert.JSONEq(t, string(want), string(raw))
}

// A commit with more checks than the query reads has its runs cut short: the
// listed checks are only part of what ran.
func TestFetch_MainBranch_SaysWhenTheChecksAreCutShort(t *testing.T) {
	t.Parallel()

	rollup := runFactsRollup()
	rollup["contexts"].(map[string]any)["checkRunCountsByState"] = []map[string]any{
		{"state": "SUCCESS", "count": 2},
		{"state": "FAILURE", "count": 1},
		{"state": "IN_PROGRESS", "count": 1},
		{"state": "QUEUED", "count": 46},
	}

	row, _ := tokenFetchWith(t, branchRef(rollup))

	require.NotEmpty(t, row.Runs)
	for _, run := range row.Runs {
		assert.True(t, run.JobsTruncated)
	}
}

// The extra facts ride nodes the query already reads, so they add no request
// and no connection: the check suite is a single object.
func TestFetch_MainBranch_AsksForTheRunFactsOnTheNodesItReads(t *testing.T) {
	t.Parallel()

	_, query := tokenFetchWith(t, nil)

	assert.Contains(t, query, "checkSuite")
	assert.Contains(t, query, "workflowRun")
	assert.Equal(t, 1, strings.Count(query, "contexts(first: 50)"), "the same 50 nodes, no more")
}
