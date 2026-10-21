package forgejo_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func jobsOf(statuses ...string) []map[string]any {
	out := make([]map[string]any, 0, len(statuses))
	for i, st := range statuses {
		out = append(out, map[string]any{"name": "job" + st + string(rune('a'+i)), "status": st})
	}

	return out
}

const (
	started = "2026-10-10T09:01:00Z"
	stopped = "2026-10-10T09:02:00Z"
	unset   = "0001-01-01T00:00:00Z"
)

// The pill counts the jobs of the commit's runs, not the runs: three push runs
// holding 11 jobs read as 11 checks (the live vps-docker commit that read
// "3 queued" while 8 jobs had passed).
func TestReadMainBranch_CountsTheJobsOfTheRuns(t *testing.T) {
	t.Parallel()

	t.Run("finished, skipped and running jobs across three runs", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{
				actionRun(3, "main", "cafef00d", "running", started, unset),
				actionRun(2, "main", "cafef00d", "success", started, stopped),
				actionRun(1, "main", "cafef00d", "success", started, stopped),
			},
			jobs: map[string][]map[string]any{
				"3": jobsOf("success", "success", "running", "running", "skipped"),
				"2": jobsOf("success", "success", "success"),
				"1": jobsOf("success", "success", "success"),
			},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{Passed: 9, Skipped: 1, Running: 2}, row.Checks, "passed includes skipped on the wire")
	})

	t.Run("a run whose jobs are all waiting shows them queued and its finished siblings do not", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{
				actionRun(2, "main", "cafef00d", "waiting", unset, unset),
				actionRun(1, "main", "cafef00d", "success", started, stopped),
			},
			jobs: map[string][]map[string]any{
				"2": jobsOf("waiting", "blocked", "waiting"),
				"1": jobsOf("success", "success"),
			},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{Passed: 2, Waiting: 3}, row.Checks)
	})

	t.Run("failed jobs count and cancelled ones count in none", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{actionRun(1, "main", "cafef00d", "failure", started, stopped)},
			jobs: map[string][]map[string]any{"1": jobsOf("success", "failure", "cancelled")},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, row.Checks)
	})

	t.Run("reads the bare array a newer Forgejo answers with", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			bareJobs: true,
			runs:     []map[string]any{actionRun(1, "main", "cafef00d", "running", started, unset)},
			jobs:     map[string][]map[string]any{"1": jobsOf("success", "running")},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{Passed: 1, Running: 1}, row.Checks)
	})

	t.Run("a run whose jobs can't be read counts as one check, the rest by job", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			jobsCode: 500,
			runs:     []map[string]any{actionRun(2, "main", "cafef00d", "running", started, unset), actionRun(1, "main", "cafef00d", "success", started, stopped)},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.CheckCounts{Passed: 1, Running: 1}, row.Checks)
	})
}

// Forgejo sends no ETag, so a finished run's job list, which never changes, is
// kept instead: a second poll of an unchanged commit reads only the runs list
// and the jobs of runs still going.
func TestReadMainBranch_ReadsAFinishedRunsJobsOnce(t *testing.T) {
	t.Parallel()

	s := &mainBranchServer{
		runs: []map[string]any{
			actionRun(2, "main", "cafef00d", "running", started, unset),
			actionRun(1, "main", "cafef00d", "success", started, stopped),
		},
		jobs: map[string][]map[string]any{"2": jobsOf("running"), "1": jobsOf("success", "success")},
	}
	client := s.start(t)

	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	first := s.requests()
	_, err = client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	second := s.requests()[len(first):]

	assert.ElementsMatch(t, []string{
		"/api/v1/repos/alrayyes/a/actions/runs",
		"/api/v1/repos/alrayyes/a/actions/runs/2/jobs",
		"/api/v1/repos/alrayyes/a/actions/runs/1/jobs",
	}, first, "one runs list and one jobs list per run")
	assert.ElementsMatch(t, []string{
		"/api/v1/repos/alrayyes/a/actions/runs",
		"/api/v1/repos/alrayyes/a/actions/runs/2/jobs",
	}, second, "the finished run's jobs are not read again")
}

// A rerun finishes again later, so its jobs are read afresh and not served from
// what was kept for the run's earlier finish.
func TestReadMainBranch_ARerunInvalidatesTheKeptJobs(t *testing.T) {
	t.Parallel()

	s := &mainBranchServer{
		runs: []map[string]any{actionRun(1, "main", "cafef00d", "failure", started, stopped)},
		jobs: map[string][]map[string]any{"1": jobsOf("success", "failure")},
	}
	client := s.start(t)
	row, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, row.Checks)

	s.runs = []map[string]any{actionRun(1, "main", "cafef00d", "success", started, "2026-10-10T09:09:00Z")}
	s.jobs = map[string][]map[string]any{"1": jobsOf("success", "success")}
	row, err = client.ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2}, row.Checks)
}

// A run that has just finished can answer an empty job list for a moment. That
// answer is not kept, or the run would read as one check for good.
func TestReadMainBranch_DoesNotKeepAnEmptyJobListOfAJustFinishedRun(t *testing.T) {
	t.Parallel()

	justNow := time.Now().UTC().Add(-time.Second).Format(time.RFC3339)
	s := &mainBranchServer{
		runs: []map[string]any{actionRun(1, "main", "cafef00d", "success", started, justNow)},
		jobs: map[string][]map[string]any{"1": {}},
	}
	client := s.start(t)
	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)

	s.jobs = map[string][]map[string]any{"1": jobsOf("success", "success", "success")}
	row, err := client.ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)
	assert.Equal(t, dashboard.CheckCounts{Passed: 3}, row.Checks)
}

// A run that finished long ago and still has no jobs never will, so its empty
// list is kept and the run is not read on every poll for good.
func TestReadMainBranch_KeepsTheEmptyJobListOfALongFinishedRun(t *testing.T) {
	t.Parallel()

	s := &mainBranchServer{
		runs: []map[string]any{actionRun(1, "main", "cafef00d", "success", started, stopped)},
		jobs: map[string][]map[string]any{"1": {}},
	}
	client := s.start(t)
	_, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	s.mu.Lock()
	s.paths = nil
	s.mu.Unlock()

	row, err := client.ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)
	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, row.Checks, "the run counts as one check")
	s.mu.Lock()
	defer s.mu.Unlock()
	assert.NotContains(t, s.paths, "/api/v1/repos/alrayyes/a/actions/runs/1/jobs")
}

// The runs list is read before the jobs, so a run can finish in between. The
// row's status and its counts must come from one reading: a run the list still
// calls running whose jobs have all finished is finished.
func TestReadMainBranch_StatusAgreesWithTheCountsWhenARunFinishesMidRead(t *testing.T) {
	t.Parallel()

	t.Run("a running run whose jobs all passed reads as passed", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{actionRun(1, "main", "cafef00d", "running", started, unset)},
			jobs: map[string][]map[string]any{"1": jobsOf("success", "skipped")},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchPassed, row.Status)
		assert.Equal(t, dashboard.CheckCounts{Passed: 2, Skipped: 1}, row.Checks)
	})

	t.Run("a running run whose jobs finished with a failure reads as failed, naming it", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{actionRun(1, "main", "cafef00d", "running", started, unset)},
			jobs: map[string][]map[string]any{"1": jobsOf("success", "failure")},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchFailed, row.Status)
		assert.Equal(t, []string{"jobfailureb"}, row.FailingJobs)
	})

	t.Run("a running run with a job still going stays running", func(t *testing.T) {
		t.Parallel()
		s := &mainBranchServer{
			runs: []map[string]any{actionRun(1, "main", "cafef00d", "running", started, unset)},
			jobs: map[string][]map[string]any{"1": jobsOf("success", "running")},
		}
		client := s.start(t)

		row, err := client.ReadMainBranch(t.Context(), repoA)

		require.NoError(t, err)
		assert.Equal(t, dashboard.MainBranchRunning, row.Status)
	})
}
