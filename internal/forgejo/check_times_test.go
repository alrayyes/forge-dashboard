package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/alrayyes/forge-dashboard/internal/forgejo"
)

var (
	jobStart = time.Date(2026, 10, 10, 9, 0, 0, 0, time.UTC)
	jobEnd   = time.Date(2026, 10, 10, 9, 5, 0, 0, time.UTC)
)

func TestListDefaultBranchChecks_CarriesTheJobTimes(t *testing.T) {
	t.Parallel()

	run := actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")
	jobs := map[string][]map[string]any{"8": {
		{"id": 31, "name": "build", "status": "failure", "started_at": "2026-10-10T09:00:00Z", "completed_at": "2026-10-10T09:05:00Z"},
		{"id": 32, "name": "test", "status": "running", "started_at": "2026-10-10T09:01:00Z", "completed_at": "0001-01-01T00:00:00Z"},
		{"id": 33, "name": "deploy", "status": "waiting"},
	}}

	checks, err := branchChecksServer(t, []map[string]any{run}, jobs).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 3)
	t.Run("a finished job has both", func(t *testing.T) {
		t.Parallel()
		require.NotNil(t, checks[0].StartedAt)
		require.NotNil(t, checks[0].CompletedAt)
		assert.True(t, jobStart.Equal(*checks[0].StartedAt))
		assert.True(t, jobEnd.Equal(*checks[0].CompletedAt))
	})
	t.Run("a running job has a start and no end", func(t *testing.T) {
		t.Parallel()
		require.NotNil(t, checks[1].StartedAt)
		assert.Nil(t, checks[1].CompletedAt, "the zero time is Forgejo's way of saying not yet")
	})
	t.Run("a job that hasn't started has neither", func(t *testing.T) {
		t.Parallel()
		assert.Nil(t, checks[2].StartedAt)
		assert.Nil(t, checks[2].CompletedAt)
	})
}

func TestListChecks_CarriesTheJobTimes(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{{"id": 42}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "jobs": []map[string]any{
			{"id": 1, "name": "build", "status": "success", "started_at": "2026-10-10T09:00:00Z", "completed_at": "2026-10-10T09:05:00Z"},
		}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := forgejo.NewClient(srv.URL, "test-token", "").ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	require.NotNil(t, checks[0].StartedAt)
	require.NotNil(t, checks[0].CompletedAt)
	assert.True(t, jobStart.Equal(*checks[0].StartedAt))
	assert.True(t, jobEnd.Equal(*checks[0].CompletedAt))
}
