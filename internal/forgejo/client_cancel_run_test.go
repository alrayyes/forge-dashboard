package forgejo_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.RunCanceler = (*forgejo.Client)(nil)

// cancelServer plays Forgejo for pull request 5: run 42 (workflow ci.yaml) has
// a finished, a running and a waiting job. cancelStatus is what the cancel
// route answers, 0 for 200.
type cancelServer struct {
	cancelStatus int
	mu           sync.Mutex
	canceled     []string
}

func (s *cancelServer) start(t *testing.T) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{
			{"id": 42, "path": ".forgejo/workflows/ci.yaml", "event": "pull_request", "status": "running"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 3, "jobs": []map[string]any{
			{"id": 1, "name": "lint", "status": "success"},
			{"id": 2, "name": "test", "status": "running"},
			{"id": 3, "name": "build", "status": "waiting"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{}})
	})
	mux.HandleFunc("POST /api/v1/repos/alrayyes/a/actions/runs/{run}/cancel", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.canceled = append(s.canceled, r.PathValue("run"))
		s.mu.Unlock()
		if s.cancelStatus != 0 {
			w.WriteHeader(s.cancelStatus)
			writeJSON(t, w, map[string]any{"message": "run is already finished"})

			return
		}
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListChecks_NamesTheRunOfEachActiveJob(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	byName := map[string]dashboard.Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	assert.Equal(t, int64(42), byName["lint"].RunID, "a finished job still says which run it belongs to")
	assert.Equal(t, "ci", byName["lint"].RunName)
	assert.Equal(t, int64(42), byName["test"].RunID)
	assert.Equal(t, "ci", byName["test"].RunName, "the workflow file without its extension")
	assert.Equal(t, int64(42), byName["build"].RunID, "a waiting job belongs to its run too")
}

func TestListDefaultBranchChecks_NamesTheRunOfEachActiveJob(t *testing.T) {
	t.Parallel()
	s := &mainBranchServer{
		runs:   []map[string]any{actionRun(3, "main", "cafef00dcafef00d", "running", "2026-10-10T09:01:00Z", "2026-10-10T09:05:00Z")},
		jobs:   map[string][]map[string]any{"3": {{"name": "test", "status": "running"}, {"name": "lint", "status": "success"}}},
		commit: goodCommit(),
	}

	checks, err := s.start(t).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, int64(3), checks[0].RunID)
	assert.Equal(t, "ci", checks[0].RunName)
	assert.Equal(t, int64(3), checks[1].RunID, "a finished job names its run too")
}

// A run whose jobs can't be read stands in as one check named for the run. It
// is cancellable (it has the run id) but carries no job id, which is how the
// dialog tells it from a real job that shares the workflow's name.
func TestListDefaultBranchChecks_RunWithNoReadableJobs_IsCancellableButHasNoJob(t *testing.T) {
	s := &mainBranchServer{
		runs:   []map[string]any{actionRun(3, "main", "cafef00dcafef00d", "running", "2026-10-10T09:01:00Z", "2026-10-10T09:05:00Z")},
		jobs:   map[string][]map[string]any{},
		commit: goodCommit(),
	}

	checks, err := s.start(t).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, int64(3), checks[0].RunID)
	assert.Zero(t, checks[0].JobID, "the stand-in check is the run, not a job")
}

// Forgejo's runs list names a run by workflow_id, title and index_in_repo and
// sends none of the SDK's path, display_title or run_number, so a run read
// through the SDK type had no name at all.
func TestListChecks_NamesTheRunsFromForgejosOwnFields(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 2, "workflow_runs": []map[string]any{
			{"id": 15785, "workflow_id": "ci.yml", "title": "fix it", "index_in_repo": 614, "event": "pull_request", "status": "running"},
			{"id": 15786, "workflow_id": "pr-title.yml", "title": "fix it", "index_in_repo": 615, "event": "pull_request", "status": "running"},
		}})
	})
	for _, id := range []string{"15785", "15786"} {
		mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/"+id+"/jobs", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"total_count": 1, "jobs": []map[string]any{{"id": 1, "name": "test", "status": "running"}}})
		})
	}
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := forgejo.NewClient(srv.URL, "test-token", "").ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 2)
	assert.Equal(t, "ci", checks[0].RunName)
	assert.Equal(t, int64(614), checks[0].RunNumber)
	assert.Equal(t, "pr-title", checks[1].RunName)
	assert.Equal(t, int64(615), checks[1].RunNumber)
}

// Runs the forge has queued may have no jobs yet (waiting, blocked, unknown).
// They still have to be offered for cancel, as the main branch does, or a push
// that queued many runs leaves all but the running one with no button.
func TestListChecks_QueuedRunWithNoJobs_IsCancellable(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 5, "workflow_runs": []map[string]any{
			{"id": 41, "workflow_id": "ci.yml", "event": "pull_request", "status": "running"},
			{"id": 42, "workflow_id": "e2e.yml", "event": "pull_request", "status": "waiting"},
			{"id": 43, "workflow_id": "lint.yml", "event": "pull_request", "status": "blocked"},
			{"id": 44, "workflow_id": "docs.yml", "event": "pull_request", "status": "unknown"},
			{"id": 45, "workflow_id": "old.yml", "event": "pull_request", "status": "success"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/41/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "jobs": []map[string]any{{"id": 1, "name": "test", "status": "running"}}})
	})
	for _, id := range []string{"42", "43", "44", "45"} {
		mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/"+id+"/jobs", func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, map[string]any{"total_count": 0, "jobs": []map[string]any{}})
		})
	}
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := forgejo.NewClient(srv.URL, "test-token", "").ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	var cancellable []int64
	for _, c := range checks {
		if c.RunID != 0 && (c.State == dashboard.CheckRunning || c.State == dashboard.CheckQueued) {
			cancellable = append(cancellable, c.RunID)
		}
	}
	assert.ElementsMatch(t, []int64{41, 42, 43, 44}, cancellable, "every unfinished run, and no finished one")
}

// queuedRunServer plays Forgejo for pull request 5 into a protected main: one
// waiting run, no jobs yet.
func queuedRunServer(t *testing.T) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 1, "workflow_runs": []map[string]any{
			{"id": 42, "workflow_id": "e2e.yml", "event": "pull_request", "status": "waiting"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs/42/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": 0, "jobs": []map[string]any{}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/branch_protections", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{{"rule_name": "main", "enable_status_check": true, "status_check_contexts": []string{"ci / test (pull_request)"}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]string{}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestListChecks_QueuedRunWithNoJobs_StandsInAsOneQueuedCheckNamedForTheWorkflow(t *testing.T) {
	t.Parallel()

	checks, err := queuedRunServer(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, "e2e", checks[0].Name)
	assert.Equal(t, dashboard.CheckQueued, checks[0].State)
	assert.Zero(t, checks[0].JobID, "the stand-in is the run, not a job")
}

// The stand-in is a run, with no job context a branch rule could name, so
// whether it is required is unknown, not "advisory".
func TestListChecks_QueuedRunWithNoJobs_RequiredStaysUnknown(t *testing.T) {
	t.Parallel()

	checks, err := queuedRunServer(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Nil(t, checks[0].Required)
}

func TestCancelRun(t *testing.T) {
	t.Parallel()

	t.Run("cancels the named run", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{}

		require.NoError(t, s.start(t).CancelRun(t.Context(), "alrayyes", "a", 42))

		assert.Equal(t, []string{"42"}, s.canceled)
	})

	t.Run("a refusal comes back classified, with Forgejo's own words", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{cancelStatus: http.StatusConflict}

		err := s.start(t).CancelRun(t.Context(), "alrayyes", "a", 42)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
		assert.Contains(t, err.Error(), "run is already finished")
	})

	t.Run("an instance without the route says so", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{cancelStatus: http.StatusNotFound}

		err := s.start(t).CancelRun(t.Context(), "alrayyes", "a", 42)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
	})
}
