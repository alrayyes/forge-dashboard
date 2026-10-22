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

var _ dashboard.DefaultBranchRerunner = (*github.Client)(nil)

// branchRerunServer plays GitHub for alrayyes/a. commits lists the default
// branch's newest commits; checks maps a commit to the conclusions of its
// check runs, whose ids are the conclusion's position plus the commit's base.
type branchRerunServer struct {
	commits []string
	checks  map[string][]string
	// held names the commits whose workflow runs wait for approval.
	held   map[string]bool
	mu     sync.Mutex
	reruns []string
}

func (s *branchRerunServer) start(t *testing.T) *github.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/commits", func(w http.ResponseWriter, _ *http.Request) {
		list := []map[string]any{}
		for _, sha := range s.commits {
			list = append(list, map[string]any{"sha": sha})
		}
		writeJSON(t, w, list)
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/{sha}/check-runs", func(w http.ResponseWriter, r *http.Request) {
		runs := []map[string]any{}
		for i, conclusion := range s.checks[r.PathValue("sha")] {
			runs = append(runs, map[string]any{"id": 100 + i, "name": "check", "status": "completed", "conclusion": conclusion, "html_url": "https://github.com/alrayyes/a/runs/x"})
		}
		writeJSON(t, w, map[string]any{"check_runs": runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/commits/{sha}/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "pending", "statuses": []map[string]any{}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		runs := []map[string]any{}
		if s.held[r.URL.Query().Get("head_sha")] {
			runs = append(runs, map[string]any{"id": 7, "name": "ci", "status": "completed", "conclusion": "action_required", "html_url": "https://github.com/alrayyes/a/actions/runs/7"})
		}
		writeJSON(t, w, map[string]any{"total_count": len(runs), "workflow_runs": runs})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/jobs/{id}", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"id": 1, "run_id": 900})
	})
	mux.HandleFunc("POST /repos/alrayyes/a/actions/runs/{run}/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.reruns = append(s.reruns, r.PathValue("run"))
		s.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL)
}

func TestRerunFailedDefaultBranchChecks_UsesTheNewestCommitThatHasChecks(t *testing.T) {
	t.Parallel()
	s := &branchRerunServer{
		commits: []string{"skipci", "ci", "older"},
		checks:  map[string][]string{"ci": {"success", "failure"}, "older": {"failure"}},
	}

	require.NoError(t, s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a"))

	assert.Equal(t, []string{"900"}, s.reruns)
}

func TestRerunFailedDefaultBranchChecks_NothingFailed_IsAConflict(t *testing.T) {
	t.Parallel()
	s := &branchRerunServer{commits: []string{"ci"}, checks: map[string][]string{"ci": {"success"}}}

	err := s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Empty(t, s.reruns)
}

// The dialog lists the newest commit when its runs are held for approval, so
// the button must not quietly rerun an older commit instead.
func TestRerunFailedDefaultBranchChecks_HeldNewestCommit_IsNeverReplacedByAnOlderOne(t *testing.T) {
	t.Parallel()
	s := &branchRerunServer{
		commits: []string{"held", "older"},
		checks:  map[string][]string{"older": {"failure"}},
		held:    map[string]bool{"held": true},
	}

	err := s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Empty(t, s.reruns)
}
