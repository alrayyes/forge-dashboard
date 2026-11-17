package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
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

func TestListChecks_CarriesTheStateGitHubReportedForALegacyStatusItCannotGrade(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"statuses": []map[string]any{
			{"context": "ci/odd", "state": "brand_new_state", "target_url": "https://ci.example/1"},
			{"context": "ci/fine", "state": "success", "target_url": "https://ci.example/2"},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	got := map[string]string{}
	for _, c := range checks {
		got[c.Name] = c.ReportedStatus
	}
	assert.Equal(t, "brand_new_state", got["ci/odd"])
	assert.Empty(t, got["ci/fine"])
}
