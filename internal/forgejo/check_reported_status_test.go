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

// A status Forgejo added later is unknown to the server, so the check carries
// the forge's own word for the page to name. A status it can grade carries none.

func TestListChecks_CarriesTheStatusForgejoSentForAJobItCannotGrade(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{
			{"id": 42, "path": ".forgejo/workflows/ci.yaml", "event": "pull_request", "status": "running"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 2, "jobs": []map[string]any{
			{"id": 1, "name": "odd", "status": "brand_new_status"},
			{"id": 2, "name": "fine", "status": "running"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := forgejo.NewClient(srv.URL, "test-token", "").ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	got := map[string]string{}
	for _, c := range checks {
		got[c.Name] = c.ReportedStatus
	}
	assert.Equal(t, "brand_new_status", got["odd"])
	assert.Empty(t, got["fine"], "a status the server can grade needs no word")
}

func TestListDefaultBranchChecks_CarriesTheStatusForgejoSentForAJobItCannotGrade(t *testing.T) {
	t.Parallel()

	run := actionRun(8, "main", "cafef00d", "running", "2026-10-10T09:00:00Z", "0001-01-01T00:00:00Z")
	jobs := map[string][]map[string]any{"8": {
		{"id": 1, "name": "odd", "status": "brand_new_status"},
		{"id": 2, "name": "fine", "status": "running"},
	}}

	checks, err := branchChecksServer(t, []map[string]any{run}, jobs).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	got := map[string]string{}
	for _, c := range checks {
		got[c.Name] = c.ReportedStatus
	}
	assert.Equal(t, "brand_new_status", got["odd"])
	assert.Empty(t, got["fine"])
}

func TestListDefaultBranchChecks_CarriesTheStatusForgejoSentForARunItCannotGrade(t *testing.T) {
	t.Parallel()

	run := actionRun(1, "main", "cafef00d", "brand_new_status", started, stopped)
	s := &mainBranchServer{runs: []map[string]any{run}, jobsFail: map[string]int{"1": 500}}

	checks, err := s.start(t).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.CheckUnknown, checks[0].State)
	assert.Equal(t, "brand_new_status", checks[0].ReportedStatus)
}
