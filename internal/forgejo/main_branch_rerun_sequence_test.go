package forgejo_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type rerunPoll struct {
	Label string                      `json:"label"`
	Runs  []map[string]any            `json:"workflow_runs"`
	Jobs  map[string][]map[string]any `json:"jobs"`
}

// rerunPolls loads the three answers Forgejo is modelled as giving around a manual rerun
// (testdata/actions_rerun_sequence.json, modelled by hand), in order.
func rerunPolls(t *testing.T) []rerunPoll {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join("testdata", "actions_rerun_sequence.json"))
	require.NoError(t, err)
	var rec struct {
		Polls []rerunPoll `json:"polls"`
	}
	require.NoError(t, json.Unmarshal(raw, &rec))

	return rec.Polls
}

// A rerun of a finished, failed run answers the same run id and job ids with a
// new attempt. Each poll across it has to give a pill and a dialog that count
// the same jobs, and the rerun's jobs, not the failed attempt's.
func TestReadMainBranch_ARerunSequenceMovesThePillAndTheDialogTogether(t *testing.T) {
	t.Parallel()

	polls := rerunPolls(t)
	require.Len(t, polls, 3)
	s := &mainBranchServer{runs: polls[0].Runs, jobs: polls[0].Jobs, bareJobs: true, commit: goodCommit()}
	client := s.start(t)
	read := func(t *testing.T, n int) (dashboard.MainBranch, []dashboard.Check) {
		t.Helper()
		s.runs, s.jobs = polls[n].Runs, polls[n].Jobs
		row, err := client.ReadMainBranch(t.Context(), repoA)
		require.NoError(t, err)
		checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")
		require.NoError(t, err)
		assert.Equal(t, row.Checks, forgejo.CountChecks(checks), polls[n].Label)

		return row, checks
	}

	attempts := func(checks []dashboard.Check) map[string]int64 {
		out := map[string]int64{}
		for _, c := range checks {
			out[c.Name] = c.RunAttempt
		}

		return out
	}

	before, beforeChecks := read(t, 0)
	assert.Equal(t, map[string]int64{"lint": 1, "build": 1, "deploy": 1}, attempts(beforeChecks))
	assert.Equal(t, dashboard.MainBranchFailed, before.Status)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2, Failed: 1}, before.Checks)

	mid, midChecks := read(t, 1)
	assert.Equal(t, dashboard.MainBranchRunning, mid.Status, "no failed job is left, so the row is running")
	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Running: 1, Waiting: 1}, mid.Checks)
	assert.Equal(t, map[string]int64{"lint": 1, "build": 2, "deploy": 2}, attempts(midChecks))

	after, afterChecks := read(t, 2)
	assert.Equal(t, map[string]int64{"lint": 1, "build": 2, "deploy": 2}, attempts(afterChecks))
	assert.Equal(t, dashboard.MainBranchPassed, after.Status)
	assert.Equal(t, dashboard.CheckCounts{Passed: 3}, after.Checks)
}
