package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The roll-up counts every commit status, so a pending one that no Actions job
// stands behind (an external CI, a required context nothing has finished)
// keeps the pull request pending. The check list has to show it too, or the
// row reads Passed from the jobs while Merge stays locked on a wait nobody can
// see (#4433).
func unjobbedStatusClient(t *testing.T, statuses []map[string]any) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{
			{"id": 42, "run_number": 7, "path": ".forgejo/workflows/ci.yaml", "event": "pull_request", "status": "success"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "jobs": []map[string]any{
			{"id": 1, "name": "build", "status": "success"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": statuses})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListChecks_ShowsAPendingStatusNoJobStandsBehind(t *testing.T) {
	t.Parallel()

	client := unjobbedStatusClient(t, []map[string]any{
		{"context": "ci/build (pull_request)", "status": "success", "target_url": "https://forge.example/alrayyes/a/actions/runs/7/jobs/0"},
		{"context": "external/scan", "status": "pending", "target_url": "https://scan.example/run/9"},
	})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	got := map[string]dashboard.CheckState{}
	for _, c := range checks {
		got[c.Name] = c.State
	}
	assert.Equal(t, dashboard.CheckRunning, got["external/scan"], "the wait the roll-up counts is listed")
	assert.Len(t, checks, 2, "a status that is a job's own is not listed twice")
}

func TestListChecks_AFinishedStatusNoJobStandsBehindIsListedWithItsOutcome(t *testing.T) {
	t.Parallel()

	client := unjobbedStatusClient(t, []map[string]any{
		{"context": "external/scan", "status": "success", "target_url": "https://scan.example/run/9"},
	})

	checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, "external/scan", checks[1].Name)
	assert.Equal(t, dashboard.CheckSuccess, checks[1].State)
}

// A commit with no runs lists its statuses as the checks. Forgejo pages them at
// 30 by default, so the 31st must come from the second page, as the roll-up
// reads it (#4433).
func TestListChecks_ListsEveryStatusOfACommitWithNoRunsAcrossPages(t *testing.T) {
	t.Parallel()

	const perPage = 30
	all := make([]map[string]string, 0, perPage+1)
	for i := range perPage + 1 {
		all = append(all, map[string]string{"status": "success", "context": "ci/" + strconv.Itoa(i)})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 0, "workflow_runs": []map[string]any{}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, r *http.Request) {
		from := 0
		if r.URL.Query().Get("page") == "2" {
			from = perPage
		}
		w.Header().Set("X-Total-Count", strconv.Itoa(len(all)))
		writeJSON(t, w, map[string]any{"state": "success", "statuses": all[from:min(from+perPage, len(all))]})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := forgejo.NewClient(srv.URL, "test-token", "").ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	assert.Len(t, checks, perPage+1)
}
