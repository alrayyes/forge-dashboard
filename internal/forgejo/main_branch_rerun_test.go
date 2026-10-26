package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A rerun keeps the run's id and its stop time, and moves its start. The jobs
// of a finished run are kept for the next poll, so a rerun that finishes must
// not be answered with the list the run had before it.
func TestReadMainBranch_AFinishedRunRerunShowsItsNewJobs(t *testing.T) {
	t.Parallel()
	run := actionRun(1, "main", "cafef00d", "failure", started, stopped)
	s := &mainBranchServer{
		runs: []map[string]any{run},
		jobs: map[string][]map[string]any{"1": jobsOf("success", "failure")},
	}
	client := s.start(t)
	first, err := client.ReadMainBranch(t.Context(), repoA)
	require.NoError(t, err)
	require.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, first.Checks)

	run["status"] = "success"
	run["started"] = "2026-10-10T09:05:00Z"
	s.jobs["1"] = jobsOf("success", "success")
	second, err := client.ReadMainBranch(t.Context(), repoA)

	require.NoError(t, err)
	assert.Equal(t, dashboard.CheckCounts{Passed: 2}, second.Checks)
}
