package github_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

func runOf(t *testing.T, checkRuns []map[string]any, name string) *dashboard.RunFacts {
	t.Helper()

	checks, err := (&cancelServer{checkRuns: checkRuns}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	for _, c := range checks {
		if c.Name == name {
			return c.Run
		}
	}
	t.Fatalf("no check named %q", name)

	return nil
}

func TestListChecks_CarriesTheFactsTheForgeGaveForTheRunBehindAJob(t *testing.T) {
	t.Parallel()

	t.Run("a running job gets its run's status and start", func(t *testing.T) {
		t.Parallel()
		got := runOf(t, []map[string]any{
			{"id": 77, "name": "test", "status": "in_progress", "html_url": "https://github.com/alrayyes/a/actions/runs/900/job/77"},
		}, "test")

		require.NotNil(t, got)
		started := time.Date(2026, 10, 27, 9, 5, 0, 0, time.UTC)
		assert.Equal(t, dashboard.CheckStatusInProgress, got.Status)
		assert.Empty(t, got.Conclusion)
		require.NotNil(t, got.StartedAt)
		assert.True(t, started.Equal(*got.StartedAt))
		assert.Nil(t, got.CompletedAt, "GitHub reports no completion time for a run")
	})

	t.Run("a finished job gets the run's own conclusion, whatever the jobs said", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(90, 800)
		job["name"] = "lint"

		got := runOf(t, []map[string]any{job}, "lint")

		require.NotNil(t, got)
		assert.Equal(t, dashboard.CheckStatusCompleted, got.Status)
		assert.Equal(t, dashboard.CheckConclusion("failure"), got.Conclusion)
	})

	t.Run("a queued run is queued", func(t *testing.T) {
		t.Parallel()
		got := runOf(t, []map[string]any{
			{"id": 79, "name": "ship", "status": "queued", "html_url": "https://github.com/alrayyes/a/actions/runs/901/job/79"},
		}, "ship")

		require.NotNil(t, got)
		assert.Equal(t, dashboard.CheckStatusQueued, got.Status)
		assert.Nil(t, got.StartedAt)
	})

	t.Run("an earlier attempt carries none, since the run's facts are its latest's", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(94, 800)
		job["name"] = "lint"
		job["html_url"] = "https://github.com/alrayyes/a/actions/runs/800/attempts/1/job/94"

		assert.Nil(t, runOf(t, []map[string]any{job}, "lint"))
	})

	t.Run("a run the lists omit carries none", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(95, 802)
		job["name"] = "lint"

		assert.Nil(t, runOf(t, []map[string]any{job}, "lint"))
	})

	t.Run("a check that is not an Actions job carries none", func(t *testing.T) {
		t.Parallel()

		assert.Nil(t, runOf(t, []map[string]any{
			{"id": 81, "name": "external", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/runs/81"},
		}, "external"))
	})
}
