package github_test

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
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
	pagedRuns    bool
	// checkRuns replaces the commit's check runs when set.
	checkRuns []map[string]any
	// completedReads counts the reads of the commit's completed runs.
	completedReads atomic.Int32
	mu             sync.Mutex
	canceled       []string
}

func (s *cancelServer) start(t *testing.T) *github.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		const u = "https://github.com/alrayyes/a/runs/x"
		if s.checkRuns != nil {
			writeJSON(t, w, map[string]any{"check_runs": s.checkRuns})

			return
		}
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
			{"id": 76, "name": "lint", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/actions/runs/800/job/76"},
			{"id": 80, "name": "docs", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/actions/runs/900/job/80"},
			{"id": 81, "name": "external", "status": "completed", "conclusion": "success", "html_url": u},
			{"id": 77, "name": "test", "status": "in_progress", "html_url": u},
			{"id": 78, "name": "build", "status": "queued", "html_url": u},
			{"id": 79, "name": "publish", "status": "in_progress", "html_url": u},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", s.runsHandler(t))
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

// runsHandler answers the commit's workflow runs, honouring the status filter.
func (s *cancelServer) runsHandler(t *testing.T) http.HandlerFunc {
	t.Helper()

	return func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "cafef00d", r.URL.Query().Get("head_sha"))
		if s.runsStatus != 0 {
			w.WriteHeader(s.runsStatus)
			writeJSON(t, w, map[string]any{"message": "boom"})

			return
		}
		all := []map[string]any{
			{"id": 800, "name": "Old", "run_number": 11, "run_attempt": 3, "status": "completed", "conclusion": "failure", "run_started_at": "2026-10-27T09:00:00Z"},
			{"id": 801, "name": "Older", "run_number": 10, "status": "completed"},
			{"id": 900, "name": "CI", "run_number": 12, "run_attempt": 2, "status": "in_progress", "run_started_at": "2026-10-27T09:05:00Z"},
			{"id": 901, "name": "Release", "status": "queued"},
		}
		status := r.URL.Query().Get("status")
		if status == "completed" {
			s.completedReads.Add(1)
		}
		if s.pagedRuns && status == "" {
			// A commit with many finished runs: the unfiltered first page holds
			// only those.
			writeJSON(t, w, map[string]any{"workflow_runs": all[:1]})

			return
		}
		list := []map[string]any{}
		for _, run := range all {
			if status == "" || run["status"] == status {
				list = append(list, run)
			}
		}
		writeJSON(t, w, map[string]any{"workflow_runs": list})
	}
}

func TestListChecks_NamesTheRunOfEachActiveJob(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	byName := map[string]dashboard.Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	assert.Equal(t, int64(800), byName["lint"].RunID, "a finished job still says which run it belongs to")
	assert.Equal(t, "Old", byName["lint"].RunName)
	assert.Equal(t, int64(11), byName["lint"].RunNumber)
	assert.Equal(t, int64(900), byName["docs"].RunID, "a finished job of a run still going")
	assert.Equal(t, "CI", byName["docs"].RunName)
	assert.Zero(t, byName["external"].RunID, "a check that is not an Actions job belongs to no run")
	assert.Equal(t, int64(900), byName["test"].RunID)
	assert.Equal(t, "CI", byName["test"].RunName)
	assert.Equal(t, int64(900), byName["build"].RunID, "a queued job belongs to its run too")
	assert.Equal(t, int64(12), byName["test"].RunNumber)
	assert.Equal(t, int64(901), byName["publish"].RunID)
	assert.Equal(t, "Release", byName["publish"].RunName)
}

// A commit with many runs spills over one page; asking the forge for queued and
// running runs only keeps an active run from being pushed off it.
func TestListChecks_NamesAnActiveRunAmongManyFinishedOnes(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{pagedRuns: true}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	byName := map[string]dashboard.Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	assert.Equal(t, int64(900), byName["test"].RunID)
	assert.Equal(t, int64(901), byName["publish"].RunID)
}

// Which run a job is in is a convenience for the dialog, never a reason to
// lose the checks themselves.
func TestListChecks_ARunLookupThatFailsStillListsTheChecks(t *testing.T) {
	t.Parallel()

	checks, err := (&cancelServer{runsStatus: http.StatusInternalServerError}).start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 6)
	byName := map[string]dashboard.Check{}
	for _, c := range checks {
		byName[c.Name] = c
	}
	assert.Equal(t, int64(800), byName["lint"].RunID, "the run id is in the job's address, no lookup needed")
	assert.Empty(t, byName["lint"].RunName, "the name needs the lookup")
	assert.Zero(t, byName["lint"].RunNumber)
	assert.Zero(t, byName["test"].RunID, "a going job's run needs the lookup")
	assert.Zero(t, byName["external"].RunID)
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

// A check held by an environment or timer reads queued, but its workflow run is
// "waiting" and cannot be cancelled, so the check names no run and the dialog
// offers no Cancel run for it.
func TestListChecks_AWaitingCheckNamesNoRun(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/cafef00d/check-runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"check_runs": []map[string]any{
			{"id": 80, "name": "deploy", "status": "waiting", "html_url": "https://github.com/alrayyes/a/runs/80"},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		runs := []map[string]any{}
		// The waiting run comes back for every status the cancel lookup asks
		// for, so only the activeRunStatuses filter keeps it from naming a run.
		// The held-run query (action_required) is a different question.
		if r.URL.Query().Get("status") != "action_required" {
			runs = append(runs, map[string]any{"id": 950, "name": "Deploy", "status": "waiting"})
		}
		writeJSON(t, w, map[string]any{"workflow_runs": runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs/950/jobs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"jobs": []map[string]any{{"id": 80}}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 5)

	require.NoError(t, err)
	require.Len(t, checks, 1)
	assert.Equal(t, dashboard.CheckQueued, checks[0].State)
	assert.Zero(t, checks[0].RunID)
}

func finishedJob(id int, run int) map[string]any {
	return map[string]any{
		"id": id, "name": "job", "status": "completed", "conclusion": "success",
		"html_url": fmt.Sprintf("https://github.com/alrayyes/a/actions/runs/%d/job/%d", run, id),
	}
}

// The completed runs are a convenience read, so they are read only when a
// finished job names a run no earlier read knew.
func TestListChecks_ReadsCompletedRunsOnlyForAFinishedJobOfAnUnknownRun(t *testing.T) {
	t.Parallel()

	t.Run("not at all when every finished job's run is a going run", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{checkRuns: []map[string]any{
			{"id": 77, "name": "test", "status": "in_progress", "html_url": "https://github.com/alrayyes/a/actions/runs/900/job/77"},
			finishedJob(80, 900),
		}}

		_, err := s.start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		assert.Zero(t, s.completedReads.Load())
	})

	t.Run("not at all when no finished job names a run", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{checkRuns: []map[string]any{
			{"id": 81, "name": "external", "status": "completed", "conclusion": "success", "html_url": "https://github.com/alrayyes/a/runs/81"},
		}}

		_, err := s.start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		assert.Zero(t, s.completedReads.Load())
	})

	t.Run("once for several finished jobs of unknown runs", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{checkRuns: []map[string]any{finishedJob(90, 800), finishedJob(91, 801), finishedJob(92, 800)}}

		checks, err := s.start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		assert.Equal(t, int32(1), s.completedReads.Load())
		assert.Equal(t, "Older", checks[1].RunName)
	})

	t.Run("a run the list omits keeps its id and no name", func(t *testing.T) {
		t.Parallel()
		s := &cancelServer{checkRuns: []map[string]any{finishedJob(93, 802)}}

		checks, err := s.start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		assert.Equal(t, int64(802), checks[0].RunID)
		assert.Empty(t, checks[0].RunName)
	})

	t.Run("a job page under a rerun attempt names its run", func(t *testing.T) {
		t.Parallel()
		job := finishedJob(94, 800)
		job["html_url"] = "https://github.com/alrayyes/a/actions/runs/800/attempts/2/job/94"
		s := &cancelServer{checkRuns: []map[string]any{job}}

		checks, err := s.start(t).ListChecks(t.Context(), "alrayyes", "a", 5)

		require.NoError(t, err)
		assert.Equal(t, int64(800), checks[0].RunID)
	})
}
