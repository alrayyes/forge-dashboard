package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
)

func TestListDefaultBranchChecks_CarriesTheRunsOwnFacts(t *testing.T) {
	t.Parallel()

	t.Run("each job of a run carries the run's status, conclusion and times", func(t *testing.T) {
		t.Parallel()
		run := actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")
		jobs := map[string][]map[string]any{"8": {{"id": 31, "name": "build", "status": "success"}}}

		checks, err := branchChecksServer(t, []map[string]any{run}, jobs).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

		require.NoError(t, err)
		require.Len(t, checks, 1)
		got := checks[0].Run
		require.NotNil(t, got)
		assert.Equal(t, dashboard.CheckStatusCompleted, got.Status)
		assert.Equal(t, dashboard.CheckConclusion("failure"), got.Conclusion, "the run's, not the job's")
		require.NotNil(t, got.StartedAt)
		require.NotNil(t, got.CompletedAt)
		assert.True(t, jobStart.Equal(*got.StartedAt))
		assert.True(t, jobEnd.Equal(*got.CompletedAt))
	})

	t.Run("a running run has a start and no conclusion", func(t *testing.T) {
		t.Parallel()
		run := actionRun(9, "main", "cafef00d", "running", "2026-10-10T09:00:00Z", "0001-01-01T00:00:00Z")
		jobs := map[string][]map[string]any{"9": {{"id": 41, "name": "build", "status": "running"}}}

		checks, err := branchChecksServer(t, []map[string]any{run}, jobs).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

		require.NoError(t, err)
		got := checks[0].Run
		require.NotNil(t, got)
		assert.Equal(t, dashboard.CheckStatusInProgress, got.Status)
		assert.Empty(t, got.Conclusion)
		assert.NotNil(t, got.StartedAt)
		assert.Nil(t, got.CompletedAt)
	})

	t.Run("the run-level fallback for unreadable jobs carries them too", func(t *testing.T) {
		t.Parallel()
		run := actionRun(8, "main", "cafef00d", "cancelled", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")

		checks, err := branchChecksServer(t, []map[string]any{run}, nil).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

		require.NoError(t, err)
		require.Len(t, checks, 1)
		require.NotNil(t, checks[0].Run)
		assert.Equal(t, dashboard.CheckStatusCompleted, checks[0].Run.Status)
		assert.Equal(t, dashboard.CheckConclusion("cancelled"), checks[0].Run.Conclusion)
	})
}

// pullChecksServer plays Forgejo for pull request 5 of alrayyes/a at cafef00d,
// answering runs as the commit's runs and jobs under each run id.
func pullChecksServer(t *testing.T, runs []map[string]any, jobs map[string][]map[string]any) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": len(runs), "workflow_runs": runs})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/{run}/jobs", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": len(jobs[r.PathValue("run")]), "jobs": jobs[r.PathValue("run")]})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "success", "statuses": []map[string]any{
			{"context": "ci/legacy", "status": "success", "target_url": "https://ci.example/1"},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListChecks_CarriesTheRunsOwnFacts(t *testing.T) {
	t.Parallel()

	t.Run("a job carries its run's status, conclusion and times", func(t *testing.T) {
		t.Parallel()
		run := actionRun(42, "feat", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")
		jobs := map[string][]map[string]any{"42": {{"id": 1, "name": "build", "status": "success"}}}

		checks, err := pullChecksServer(t, []map[string]any{run}, jobs).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		require.Len(t, checks, 1)
		got := checks[0].Run
		require.NotNil(t, got)
		assert.Equal(t, dashboard.CheckStatusCompleted, got.Status)
		assert.Equal(t, dashboard.CheckConclusion("failure"), got.Conclusion)
		require.NotNil(t, got.StartedAt)
		require.NotNil(t, got.CompletedAt)
		assert.True(t, jobStart.Equal(*got.StartedAt))
		assert.True(t, jobEnd.Equal(*got.CompletedAt))
	})

	t.Run("the stand-in for a run with no jobs carries the run's status", func(t *testing.T) {
		t.Parallel()
		run := actionRun(43, "feat", "cafef00d", "waiting", "0001-01-01T00:00:00Z", "0001-01-01T00:00:00Z")

		checks, err := pullChecksServer(t, []map[string]any{run}, nil).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		require.Len(t, checks, 1)
		require.NotNil(t, checks[0].Run)
		assert.Equal(t, dashboard.CheckStatusQueued, checks[0].Run.Status)
		assert.Empty(t, checks[0].Run.Conclusion)
		assert.Nil(t, checks[0].Run.StartedAt)
		assert.Nil(t, checks[0].Run.CompletedAt)
	})

	t.Run("a legacy commit status belongs to no run and carries none", func(t *testing.T) {
		t.Parallel()

		checks, err := pullChecksServer(t, nil, nil).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		require.Len(t, checks, 1)
		assert.Nil(t, checks[0].Run)
	})
}
