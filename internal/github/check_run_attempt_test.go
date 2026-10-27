package github_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func attemptOf(t *testing.T, checkRuns []map[string]any) map[string]int64 {
	t.Helper()

	checks, err := (&cancelServer{checkRuns: checkRuns}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)
	require.NoError(t, err)
	out := map[string]int64{}
	for _, c := range checks {
		out[c.Name] = c.RunAttempt
	}

	return out
}

func TestListChecks_CarriesTheAttemptOfTheRunBehindAJob(t *testing.T) {
	t.Parallel()

	t.Run("a running job takes its run's attempt", func(t *testing.T) {
		t.Parallel()
		got := attemptOf(t, []map[string]any{
			{"id": 77, "name": "test", "status": "in_progress", "html_url": "https://github.com/alrayyes/a/runs/x"},
		})

		assert.EqualValues(t, 2, got["test"])
	})

	t.Run("a finished job takes the attempt of the completed run", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(90, 800)
		job["name"] = "lint"

		assert.EqualValues(t, 3, attemptOf(t, []map[string]any{job})["lint"])
	})

	t.Run("the attempt in a job's page address wins", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(94, 800)
		job["name"] = "lint"
		job["html_url"] = "https://github.com/alrayyes/a/actions/runs/800/attempts/1/job/94"

		assert.EqualValues(t, 1, attemptOf(t, []map[string]any{job})["lint"])
	})

	t.Run("a run the list omits still gives the attempt from the address", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(95, 802)
		job["name"] = "lint"
		job["html_url"] = "https://github.com/alrayyes/a/actions/runs/802/attempts/4/job/95"

		assert.EqualValues(t, 4, attemptOf(t, []map[string]any{job})["lint"])
	})

	t.Run("a check that is not an Actions job has none", func(t *testing.T) {
		t.Parallel()

		assert.Zero(t, attemptOf(t, []map[string]any{
			{"id": 81, "name": "external", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/runs/81"},
		})["external"])
	})
}
