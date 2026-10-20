package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.DefaultBranchChecker = (*forgejo.Client)(nil)

// branchChecksServer plays Forgejo for alrayyes/a: the repo says its default
// branch is main, the runs list answers for the branch, and each run's jobs
// answer under its id.
func branchChecksServer(t *testing.T, runs []map[string]any, jobs map[string][]map[string]any) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"name": "a", "default_branch": "main"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		sha := r.URL.Query().Get("head_sha")
		var listed []map[string]any
		for _, run := range runs {
			if sha == "" || run["commit_sha"] == sha {
				listed = append(listed, run)
			}
		}
		writeJSON(t, w, map[string]any{"total_count": len(listed), "workflow_runs": listed})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/{run}/jobs", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "jobs": jobs[r.PathValue("run")]})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListDefaultBranchChecks_ReturnsTheJobsOfTheNewestCommitsRuns(t *testing.T) {
	t.Parallel()

	client := branchChecksServer(t,
		[]map[string]any{
			actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z"),
			actionRun(7, "main", "deadbeef", "success", "2026-10-09T09:00:00Z", "2026-10-09T09:05:00Z"),
		},
		map[string][]map[string]any{
			"8": {
				{"name": "build", "status": "success", "html_url": "https://forge.example/alrayyes/a/actions/runs/8/jobs/1"},
				{"name": "test", "status": "failure", "html_url": "https://forge.example/alrayyes/a/actions/runs/8/jobs/2"},
			},
			"7": {{"name": "old", "status": "success"}},
		})

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, "build", checks[0].Name)
	assert.Equal(t, dashboard.CheckFailure, checks[1].State)
}

func TestListDefaultBranchChecks_NoRunOnTheBranch_ReturnsNone(t *testing.T) {
	t.Parallel()

	client := branchChecksServer(t,
		[]map[string]any{actionRun(3, "#4", "cafef00d", "success", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")},
		nil)

	checks, err := client.ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	assert.Empty(t, checks)
}

func TestListDefaultBranchChecks_RepoLookupFails_ReturnsError(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()

	_, err := forgejo.NewClient(srv.URL, "test-token", "").ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.Error(t, err)
}
