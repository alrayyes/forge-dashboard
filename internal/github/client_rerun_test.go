package github_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.ChecksRerunner = (*github.Client)(nil)

// rerunServer plays GitHub for pull request 5 (#698). jobs maps a check run's
// id to the workflow run it belongs to, 0 for a check that isn't an Actions
// job (the job lookup answers 404). rerunStatus is what the rerun route
// answers. reruns records each workflow run asked to rerun, in order.
type rerunServer struct {
	conclusions map[int64]string
	jobs        map[int64]int64
	rerunStatus int
	mu          sync.Mutex
	reruns      []string
}

func (s *rerunServer) start(t *testing.T) *github.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		runs := []map[string]any{}
		for _, id := range []int64{76, 77, 78, 79} {
			conclusion, ok := s.conclusions[id]
			if !ok {
				continue
			}
			runs = append(runs, map[string]any{"id": id, "name": "check", "status": "completed", "conclusion": conclusion, "html_url": "https://github.com/alrayyes/a/runs/x"})
		}
		writeJSON(t, w, map[string]any{"check_runs": runs})
	})
	for id, run := range s.jobs {
		mux.HandleFunc("/repos/alrayyes/a/actions/jobs/"+strconv.FormatInt(id, 10), func(w http.ResponseWriter, _ *http.Request) {
			if run == 0 {
				w.WriteHeader(http.StatusNotFound)
				writeJSON(t, w, map[string]any{"message": "Not Found"})

				return
			}
			writeJSON(t, w, map[string]any{"id": id, "run_id": run, "steps": []map[string]any{}})
		})
	}
	mux.HandleFunc("POST /repos/alrayyes/a/actions/runs/{run}/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.reruns = append(s.reruns, r.PathValue("run"))
		s.mu.Unlock()
		if s.rerunStatus != 0 {
			w.WriteHeader(s.rerunStatus)
			writeJSON(t, w, map[string]any{"message": "Resource not accessible by integration"})

			return
		}
		w.WriteHeader(http.StatusCreated)
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestRerunFailedChecks(t *testing.T) {
	t.Parallel()

	t.Run("reruns each workflow run holding a failed job once", func(t *testing.T) {
		t.Parallel()
		s := &rerunServer{
			conclusions: map[int64]string{76: "success", 77: "failure", 78: "timed_out", 79: "failure"},
			jobs:        map[int64]int64{76: 900, 77: 900, 78: 900, 79: 901},
		}

		require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

		assert.ElementsMatch(t, []string{"900", "901"}, s.reruns)
	})

	t.Run("a failed check that isn't an Actions job is left alone", func(t *testing.T) {
		t.Parallel()
		s := &rerunServer{
			conclusions: map[int64]string{77: "failure", 79: "failure"},
			jobs:        map[int64]int64{77: 0, 79: 901},
		}

		require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

		assert.Equal(t, []string{"901"}, s.reruns)
	})

	t.Run("nothing to rerun is a conflict, and GitHub is never asked", func(t *testing.T) {
		t.Parallel()
		s := &rerunServer{
			conclusions: map[int64]string{76: "success", 77: "failure"},
			jobs:        map[int64]int64{76: 900, 77: 0},
		}

		err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
		assert.Empty(t, s.reruns)
	})

	t.Run("a refusal from GitHub comes back classified, with its own words", func(t *testing.T) {
		t.Parallel()
		s := &rerunServer{
			conclusions: map[int64]string{77: "failure"},
			jobs:        map[int64]int64{77: 900},
			rerunStatus: http.StatusForbidden,
		}

		err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

		clientErr, ok := errors.AsType[*dashboard.ClientError](err)
		require.True(t, ok, "want a ClientError, got %v", err)
		assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
		assert.Contains(t, err.Error(), "Resource not accessible by integration")
	})
}
