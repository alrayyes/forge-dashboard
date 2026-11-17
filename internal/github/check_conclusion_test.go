package github_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListChecks_CarriesTheConclusionGitHubReported(t *testing.T) {
	t.Parallel()

	conclusions := []string{"success", "neutral", "failure", "stale", "cancelled", "skipped", "timed_out", "action_required", "startup_failure"}
	runs := []map[string]any{}
	for i, conclusion := range conclusions {
		runs = append(runs, map[string]any{
			"id": 200 + i, "name": conclusion, "status": "completed", "conclusion": conclusion,
			"html_url": "https://github.com/alrayyes/a/runs/x",
		})
	}
	runs = append(runs, map[string]any{"id": 300, "name": "going", "status": "in_progress", "html_url": "https://github.com/alrayyes/a/runs/y"})

	checks, err := (&cancelServer{checkRuns: runs}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	got := map[string]string{}
	for _, c := range checks {
		got[c.Name] = c.ReportedConclusion
	}
	for _, conclusion := range conclusions {
		assert.Equal(t, conclusion, got[conclusion], conclusion)
	}
	assert.Empty(t, got["going"], "a job still going has not concluded")
}

func TestListChecks_CarriesTheStatusGitHubReportedForACheckItCannotGrade(t *testing.T) {
	t.Parallel()

	runs := []map[string]any{
		{"id": 400, "name": "odd", "status": "brand_new_status", "html_url": "https://github.com/alrayyes/a/runs/z"},
	}

	checks, err := (&cancelServer{checkRuns: runs}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, "brand_new_status", checks[0].ReportedStatus)
}
