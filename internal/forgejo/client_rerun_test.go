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

// rerunServer plays Forgejo for pull request 5. runs is the Actions runs on the
// head commit, and the embedded fakeJobs holds their jobs and takes the job
// reruns. A failed run with no jobs listed gets one failed job, id 100 plus
// the run's, so a test that only cares about runs stays short.
type rerunServer struct {
	fakeJobs

	runs    []map[string]any
	mu      sync.Mutex
	headSHA string
}

// withDefaultJobs gives every failed run a failed job and a passing one.
func (s *rerunServer) withDefaultJobs() {
	if s.jobs == nil {
		s.jobs = map[int][]map[string]any{}
	}
	for _, run := range s.runs {
		id, _ := run["id"].(int)
		if _, ok := s.jobs[id]; !ok {
			s.jobs[id] = []map[string]any{job(id+100, run["status"].(string)), job(id+200, "success")}
		}
	}
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
	s.withDefaultJobs()
	s.register(t, mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", "")
}

func TestRerunFailedChecks_RerunsOnlyTheFailedJobsOfTheFailedRuns(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{
		{"id": 41, "status": "success"},
		{"id": 42, "status": "failure"},
		{"id": 43, "status": "running"},
		{"id": 44, "status": "failure"},
	}}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.ElementsMatch(t, []string{"142", "144"}, s.rerunsSeen(), "the failed job of each failed run, not the passing one")
}

// A deploy job that passed beside a failed test job must not go again.
func TestRerunFailedChecks_LeavesPassingJobsOfAFailedRunAlone(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{
		42: {job(1, "success"), job(2, "failure"), job(3, "success"), job(4, "failure")},
	}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, []string{"2", "4"}, s.rerunsSeen())
}

// Forgejo restarts a job's dependents with it, so a failed job that was
// restarted that way is already going and must not be asked again.
func TestRerunFailedChecks_SkipsAFailedJobTheForgeAlreadyRestartedAsADependent(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure"), job(2, "failure"), job(3, "failure")}}
	s.cascade = map[int][]int{1: {2}}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, []string{"1", "3"}, s.rerunsSeen())
}

// The jobs are read again only when a second job is to be rerun.
func TestRerunFailedChecks_ReadsTheJobsOnceForAFailedRunWithOneFailedJob(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}

	require.NoError(t, s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, 1, s.listingsSeen())
}

func TestRerunFailedChecks_AFailedRunWhoseJobsAllPassed_IsNothingToRerun(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "success")}}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	assert.Equal(t, "no failed job to rerun on this pull request", dashboard.ForgeMessage(err))
	assert.Empty(t, s.rerunsSeen())
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
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.status = http.StatusForbidden

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorUnauthorized, clientErr.Kind)
}

func TestRerunFailedChecks_ARefusal_CarriesForgejosOwnWords(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.status = http.StatusForbidden

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
