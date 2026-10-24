package forgejo_test

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ dashboard.DefaultBranchRerunner = (*forgejo.Client)(nil)

// branchRerunServer plays Forgejo for alrayyes/a, whose default branch is
// main. runs is the Actions runs list, in Forgejo's own field names.
type branchRerunServer struct {
	fakeJobs

	runs []map[string]any
	mu   sync.Mutex
	// repoLookups counts reads of the repository itself.
	repoLookups int
}

func (s *branchRerunServer) start(t *testing.T) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		s.repoLookups++
		s.mu.Unlock()
		writeJSON(t, w, map[string]any{"name": "a", "default_branch": "main"})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"total_count": len(s.runs), "workflow_runs": s.runs})
	})
	s.jobs = map[int][]map[string]any{}
	for _, run := range s.runs {
		id, _ := run["id"].(int)
		s.jobs[id] = []map[string]any{job(id+100, run["status"].(string)), job(id+200, "success")}
	}
	s.register(t, mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func branchRun(id int, sha, ref, status string) map[string]any {
	return map[string]any{"id": id, "commit_sha": sha, "prettyref": ref, "status": status, "event": "push"}
}

func TestRerunFailedDefaultBranchChecks_RerunsOnlyTheFailedRunsOfTheNewestCommit(t *testing.T) {
	t.Parallel()
	s := &branchRerunServer{runs: []map[string]any{
		branchRun(40, "old", "main", "failure"),
		branchRun(41, "new", "main", "success"),
		branchRun(42, "new", "main", "failure"),
		branchRun(43, "new", "feature", "failure"),
		{"id": 44, "commit_sha": "new", "prettyref": "#7", "status": "failure", "event": "pull_request"},
	}}

	require.NoError(t, s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "main"))

	assert.Equal(t, []string{"142"}, s.rerunsSeen())
	assert.Zero(t, s.repoLookups, "the default branch is known, so the repository isn't read")
}

func TestRerunFailedDefaultBranchChecks_NoFailedRun_IsAConflict(t *testing.T) {
	t.Parallel()
	s := &branchRerunServer{runs: []map[string]any{branchRun(41, "new", "main", "success")}}

	err := s.start(t).RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "main")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Equal(t, "no failed job to rerun on this branch", dashboard.ForgeMessage(err))
	assert.Empty(t, s.rerunsSeen())
}

func TestRerunFailedDefaultBranchChecks_RunsListMissing_IsAnErrorNotNothingToRerun(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"name": "a", "default_branch": "main"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	err := forgejo.NewClient(srv.URL, "test-token", "").RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "main")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}

func TestRerunFailedDefaultBranchChecks_EmptyBranch_IsAConflictWithoutAnyRequest(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)

	err := forgejo.NewClient(srv.URL, "test-token", "").RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "")

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Zero(t, requests.Load(), "an empty repository has no branch to look up")
}
