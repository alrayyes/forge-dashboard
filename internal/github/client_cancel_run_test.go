package github_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.RunCanceler = (*github.Client)(nil)

// cancelServer plays GitHub for pull request 5. Check run 76 is a finished job
// of run 800, 77 and 78 are a running and a queued job of run 900 ("CI"), 79 is
// a running job of run 901 ("Release"). cancelStatus is what the cancel route
// answers, 0 for 202.
type cancelServer struct {
	cancelStatus int
	runsStatus   int
	mu           sync.Mutex
	canceled     []string
}

func (s *cancelServer) start(t *testing.T) *github.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		const u = "https://github.com/alrayyes/a/runs/x"
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
			{"id": 76, "name": "lint", "status": "completed", "conclusion": "success", "html_url": u},
			{"id": 77, "name": "test", "status": "in_progress", "html_url": u},
			{"id": 78, "name": "build", "status": "queued", "html_url": u},
			{"id": 79, "name": "publish", "status": "in_progress", "html_url": u},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "cafef00d", r.URL.Query().Get("head_sha"))
		if s.runsStatus != 0 {
			w.WriteHeader(s.runsStatus)
			writeJSON(t, w, map[string]any{"message": "boom"})

			return
		}
		writeJSON(t, w, map[string]any{"workflow_runs": []map[string]any{
			{"id": 800, "name": "Old", "status": "completed"},
			{"id": 900, "name": "CI", "status": "in_progress"},
			{"id": 901, "name": "Release", "status": "queued"},
		}})
	})
	jobs := func(ids ...int) func(http.ResponseWriter, *http.Request) {
		return func(w http.ResponseWriter, _ *http.Request) {
			list := []map[string]any{}
			for _, id := range ids {
				list = append(list, map[string]any{"id": id})
			}
			writeJSON(t, w, map[string]any{"jobs": list})
		}
	}
	mux.HandleFunc("/repos/alrayyes/a/actions/runs/900/jobs", jobs(77, 78))
	mux.HandleFunc("/repos/alrayyes/a/actions/runs/901/jobs", jobs(79))
	mux.HandleFunc("/repos/alrayyes/a/actions/runs/800/jobs", func(http.ResponseWriter, *http.Request) {
		assert.Fail(t, "a finished run's jobs are not read")
	})
	mux.HandleFunc("POST /repos/alrayyes/a/actions/runs/{run}/cancel", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.canceled = append(s.canceled, r.PathValue("run"))
		s.mu.Unlock()
		if s.cancelStatus != 0 {
			w.WriteHeader(s.cancelStatus)
			writeJSON(t, w, map[string]any{"message": "Cannot cancel a workflow run that is completed."})

			return
		}
		w.WriteHeader(http.StatusAccepted)
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestListChecks_NamesTheRunOfEachActiveJob(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	byName := map[string]dashboard.Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	assert.Zero(t, byName["lint"].RunID, "a finished job has no run to cancel")
	assert.Equal(t, int64(900), byName["test"].RunID)
	assert.Equal(t, "CI", byName["test"].RunName)
	assert.Equal(t, int64(900), byName["build"].RunID, "a queued job belongs to its run too")
	assert.Equal(t, int64(901), byName["publish"].RunID)
	assert.Equal(t, "Release", byName["publish"].RunName)
}

// Which run a job is in is a convenience for the dialog, never a reason to
// lose the checks themselves.
func TestListChecks_ARunLookupThatFailsStillListsTheChecks(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{runsStatus: http.StatusInternalServerError}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 4)
	for _, c := range checks {
		assert.Zero(t, c.RunID, c.Name)
	}
}

func TestCancelRun(t *testing.T) {
	t.Parallel()

	t.Run("cancels the named run", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{}

		require.NoError(t, s.start(t).CancelRun(t.Context(), "alrayyes", "a", 900))

		assert.Equal(t, []string{"900"}, s.canceled)
	})

	t.Run("a run that already finished is a conflict with GitHub's own words", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{cancelStatus: http.StatusConflict}

		err := s.start(t).CancelRun(t.Context(), "alrayyes", "a", 900)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
		assert.Contains(t, err.Error(), "Cannot cancel a workflow run that is completed.")
	})

	t.Run("a token that can't write to Actions is unauthorized", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{cancelStatus: http.StatusForbidden}

		err := s.start(t).CancelRun(t.Context(), "alrayyes", "a", 900)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
	})
}
