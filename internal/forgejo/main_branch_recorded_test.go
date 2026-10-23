package forgejo_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// recordedRuns loads a Forgejo runs list and the jobs of each run as the
// instance answered them (testdata/actions_scaffold_go_cli.json).
func recordedRuns(t *testing.T, file string) *mainBranchServer {
	t.Helper()

	raw, err := os.ReadFile(filepath.Join("testdata", file)) //nolint:gosec // a fixed testdata name
	require.NoError(t, err)
	var rec struct {
		Runs []map[string]any            `json:"workflow_runs"`
		Jobs map[string][]map[string]any `json:"jobs"`
	}
	require.NoError(t, json.Unmarshal(raw, &rec))

	return &mainBranchServer{runs: rec.Runs, jobs: rec.Jobs, bareJobs: true, commit: goodCommit()}
}

func TestReadMainBranch_RecordedScaffoldGoCli(t *testing.T) {
	t.Parallel()

	s := recordedRuns(t, "actions_scaffold_go_cli.json")
	client := s.start(t)

	row, err := client.ReadMainBranch(t.Context(), dashboard.RepoRef{
		FullName: "alrayyes/a", Owner: "alrayyes", Name: "a", DefaultBranch: "main",
	})

	require.NoError(t, err)
	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
	assert.Equal(t, dashboard.CheckCounts{Passed: 14, Skipped: 10}, row.Checks)
}

// countsOf tallies a dialog's job list the way the pill's counts read: passed
// includes skipped, cancelled counts in none.
func countsOf(checks []dashboard.Check) dashboard.CheckCounts {
	var out dashboard.CheckCounts
	for _, c := range checks {
		switch c.State {
		case dashboard.CheckSuccess:
			out.Passed++
		case dashboard.CheckSkipped:
			out.Passed++
			out.Skipped++
		case dashboard.CheckRunning:
			out.Running++
		case dashboard.CheckQueued:
			out.Waiting++
		case dashboard.CheckFailure:
			out.Failed++
		case dashboard.CheckCancelled:
		}
	}

	return out
}

func TestPillAndDialogCountTheSameJobs(t *testing.T) {
	t.Parallel()

	agree := func(t *testing.T, s *mainBranchServer) {
		t.Helper()
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)
		require.NoError(t, err)
		checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")
		require.NoError(t, err)

		assert.Equal(t, row.Checks, countsOf(checks))
	}

	t.Run("the recorded scaffold-go-cli commit", func(t *testing.T) {
		t.Parallel()
		agree(t, recordedRuns(t, "actions_scaffold_go_cli.json"))
	})

	t.Run("a run whose jobs can't be read is one check in both", func(t *testing.T) {
		t.Parallel()
		s := recordedRuns(t, "actions_scaffold_go_cli.json")
		s.jobsFail = map[string]int{"15130": 500}
		agree(t, s)
	})

	t.Run("a run that is still going", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{
				actionRun(2, "main", "cafef00d", "running", started, unset),
				actionRun(1, "main", "cafef00d", "success", started, stopped),
			},
			jobs: map[string][]map[string]any{"2": jobsOf("success", "running", "waiting"), "1": jobsOf("success", "skipped")},
		}
		agree(t, s)
	})
}

// A finished run's jobs are kept, so a list read while a job still showed as
// running must not be kept: the pill would say running for as long as the
// process lives.
func TestReadMainBranch_DoesNotKeepAJobListWithAJobStillGoing(t *testing.T) {
	t.Parallel()

	s := &mainBranchServer{
		runs: []map[string]any{actionRun(1, "main", "cafef00d", "success", started, stopped)},
		jobs: map[string][]map[string]any{"1": jobsOf("success", "running")},
	}
	client := s.start(t)

	first, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	assert.Equal(t, 1, first.Checks.Running)

	s.jobs = map[string][]map[string]any{"1": jobsOf("success", "success")}
	second, err := client.ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2}, second.Checks)
}
