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

var _ dashboard.ChecksRerunner = (*forgejo.Client)(nil)

// rerunServer plays Forgejo for pull request 5. runs maps each Actions run on
// the head commit to its status. rerunStatus is what the rerun route answers
// (0 for 201). reruns records each run asked to rerun, in order.
type rerunServer struct {
	runs        []map[string]any
	rerunStatus int
	mu          sync.Mutex
	reruns      []string
	headSHA     string
}

func (s *rerunServer) start(t *testing.T) *forgejo.Client {
	t.Helper()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls/5", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 5, "head": map[string]string{"sha": "cafef00d"}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.headSHA = r.URL.Query().Get("head_sha")
		s.mu.Unlock()
		writeJSON(t, w, map[string]any{"total_count": len(s.runs), "workflow_runs": s.runs})
	})
	mux.HandleFunc("POST /api/v1/repos/alrayyes/a/actions/runs/{run}/rerun-failed-jobs", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.reruns = append(s.reruns, r.PathValue("run"))
		s.mu.Unlock()
		if s.rerunStatus != 0 {
			w.WriteHeader(s.rerunStatus)
			writeJSON(t, w, map[string]any{"message": "token does not have at least one of required scope(s)"})

			return
		}
		w.WriteHeader(http.StatusCreated)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func (s *rerunServer) rerunsSeen() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.reruns...)
}

func TestRerunFailedChecks_RerunsOnlyTheFailedRuns(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{
		{"id": 41, "status": "success"},
		{"id": 42, "status": "failure"},
		{"id": 43, "status": "running"},
		{"id": 44, "status": "failure"},
	}}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.ElementsMatch(t, []string{"42", "44"}, s.rerunsSeen())
}

func TestRerunFailedChecks_LooksRunsUpByTheHeadCommit(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, "cafef00d", s.headSHA)
}

func TestRerunFailedChecks_NoFailedRun_IsAConflictAndForgejoIsNeverAsked(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 41, "status": "success"}}}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
	assert.Empty(t, s.rerunsSeen())
}

func TestRerunFailedChecks_NoRunsAtAll_ForAnExternalCI_IsAConflict(t *testing.T) {
	t.Parallel()
	s := &rerunServer{}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorConflict, clientErr.Kind)
}

func TestRerunFailedChecks_ConflictReadsAsASentence_WithoutAForgePrefix(t *testing.T) {
	t.Parallel()
	s := &rerunServer{}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	assert.Equal(t, "no failed job to rerun on this pull request", dashboard.ForgeMessage(err))
}

func TestRerunFailedChecks_ARefusal_ComesBackClassified(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}, rerunStatus: http.StatusForbidden}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
}

func TestRerunFailedChecks_ARefusal_CarriesForgejosOwnWords(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}, rerunStatus: http.StatusForbidden}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	assert.Contains(t, err.Error(), "token does not have at least one of required scope(s)")
}

func TestRerunFailedChecks_PullRequestLookupFails_ReturnsTheError(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(srv.Close)

	err := forgejo.NewClient(srv.URL, "test-token", "").RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorNotFound, clientErr.Kind)
}
