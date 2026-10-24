package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// If Forgejo refuses a later job after an earlier one went, the person is told
// which jobs restarted and which did not, so a second click isn't a guess.
func TestRerunFailedChecks_ARefusedLaterJob_SaysWhichRestartedAndWhichDidNot(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}, {"id": 44, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{
		42: {job(1, "failure"), job(2, "failure"), job(3, "failure")},
		44: {job(4, "failure")},
	}
	s.status = http.StatusForbidden
	s.okFirst = 1

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Equal(t, dashboard.ActionPermission, got.Code)
	assert.Contains(t, got.Message, "Restarted job-1. Did not restart job-2, job-3 and the failed jobs of 1 other run.")
}

func TestRerunFailedChecks_ARefusedFirstJob_ReportsNoPartialRerun(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure"), job(2, "failure")}}
	s.status = http.StatusForbidden

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.NotContains(t, got.Message, "Restarted")
}

// A job Forgejo restarted along with an earlier one is going again, so it is
// not listed among the jobs left undone.
func TestRerunFailedChecks_ARefusalAfterACascade_DoesNotListWhatTheCascadeRestarted(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure"), job(2, "failure"), job(3, "failure")}}
	s.cascade = map[int][]int{1: {3}}
	s.status = http.StatusForbidden
	s.okFirst = 1

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Contains(t, got.Message, "Restarted job-1. Did not restart job-2.")
	assert.NotContains(t, got.Message, "job-3")
}

// When the jobs of the next run can't be listed, that run and every run after
// it were not restarted.
func TestRerunFailedChecks_AFailedJobListOnTheSecondRun_CountsThatRunAndTheLaterOnes(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{
		{"id": 42, "status": "failure"}, {"id": 43, "status": "failure"}, {"id": 44, "status": "failure"},
	}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure")}, 43: {job(2, "failure")}, 44: {job(3, "failure")}}
	s.listFail = map[int]int{43: http.StatusInternalServerError}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Contains(t, got.Message, "Restarted job-1. Did not restart the failed jobs of 2 other runs.")
}

// A list that fails partway can't say which of the remaining jobs went, so it
// doesn't name any as left undone.
func TestRerunFailedChecks_AFailedReList_DoesNotClaimWhichJobsWereLeft(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure"), job(2, "failure"), job(3, "failure")}}
	s.listFailAfter = 2

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Contains(t, got.Message, "Restarted job-1, job-2.")
	assert.NotContains(t, got.Message, "Did not restart job-3")
}

// A job list the forge answers with something unreadable is still reported
// with what had already restarted.
func TestRerunFailedChecks_AnUnreadableJobList_StillSaysWhatRestarted(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}, {"id": 43, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure")}, 43: {job(2, "failure")}}
	s.listBody = map[int]string{43: "<html>not json</html>"}

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Contains(t, got.Message, "Restarted job-1.")
}

// A version read that never gets an answer says nothing the forge said, so it
// adds no request to the log.
func TestRerunChecksBlockedReason_AVersionReadWithNoAnswerIsNotLogged(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/version", func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	rec := &fakeRecorder{}
	c := forgejo.NewClient(srv.URL, "test-token", "", rec)

	_ = settled(c)

	var seen int
	for _, e := range rec.all() {
		if e.Endpoint == "/version" {
			seen++
		}
	}
	assert.Zero(t, seen)
}

// A click that finds the version stale while the background read is under way
// waits for that read instead of sending a second one.
func TestRerunFailedChecks_AClickDuringTheBackgroundVersionRead_SharesItsRequest(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	reads := 0
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/version", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		reads++
		mu.Unlock()
		started <- struct{}{}
		<-release
		writeJSON(t, w, map[string]any{"version": "16.0.0"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	c := forgejo.NewClient(srv.URL, "test-token", "")
	_ = c.RerunChecksBlockedReason()
	<-started

	done := make(chan error, 1)
	go func() { done <- c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5) }()
	select {
	case <-started:
	case <-time.After(200 * time.Millisecond):
	}
	close(release)

	err := <-done
	require.Error(t, err)
	mu.Lock()
	defer mu.Unlock()
	assert.Equal(t, 1, reads)
}

// versionOnlyServer answers /version and counts every other request.
func versionOnlyServer(t *testing.T, version string) (*forgejo.Client, func() int) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"version": version})
	})
	var mu sync.Mutex
	other := 0
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		other++
		mu.Unlock()
		http.NotFound(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return forgejo.NewClient(srv.URL, "test-token", ""), func() int {
		mu.Lock()
		defer mu.Unlock()

		return other
	}
}

// A click on an instance with no rerun route is refused before the pull request
// or its runs are looked up, so "no failed job" can't hide the real reason.
func TestRerunFailedChecks_OnForgejo16_ChecksTheVersionBeforeLookingAnythingUp(t *testing.T) {
	t.Parallel()
	c, others := versionOnlyServer(t, "16.0.6+gitea-1.22.0")

	err := c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	assert.Equal(t, noRerunReason, dashboard.ForgeMessage(err))
	assert.Zero(t, others(), "nothing but the version was asked")
}

func TestRerunFailedDefaultBranchChecks_OnForgejo16_ChecksTheVersionBeforeLookingAnythingUp(t *testing.T) {
	t.Parallel()
	c, others := versionOnlyServer(t, "16.0.6+gitea-1.22.0")

	err := c.RerunFailedDefaultBranchChecks(t.Context(), "alrayyes", "a", "main")

	assert.Equal(t, noRerunReason, dashboard.ForgeMessage(err))
	assert.Zero(t, others(), "nothing but the version was asked")
}

// The version probe is classified like every other forge call: a 429 on it is
// logged as rate limiting, not as a plain failure.
func TestRerunChecksBlockedReason_ARateLimitedVersionProbeIsLoggedAsRateLimited(t *testing.T) {
	t.Parallel()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	rec := &fakeRecorder{}
	c := forgejo.NewClient(srv.URL, "test-token", "", rec)

	_ = settled(c)

	var outcomes []string
	for _, e := range rec.all() {
		if e.Endpoint == "/version" {
			outcomes = append(outcomes, e.Outcome)
		}
	}
	assert.Equal(t, []string{string(dashboard.ForgeErrorRateLimited)}, outcomes)
}

// A POST that got no answer may still have been queued, so the job it was for
// is not reported as one that did not restart.
func TestRerunFailedChecks_APostWithNoAnswer_SaysTheJobMayHaveRestarted(t *testing.T) {
	t.Parallel()
	s := &rerunServer{runs: []map[string]any{{"id": 42, "status": "failure"}}}
	s.jobs = map[int][]map[string]any{42: {job(1, "failure"), job(2, "failure"), job(3, "failure")}}
	s.status = http.StatusForbidden
	s.okFirst = 1
	s.drop = true

	err := s.start(t).RerunFailedChecks(t.Context(), "alrayyes", "a", 5)

	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Contains(t, got.Message, "Restarted job-1. job-2 may have restarted too. Did not restart job-3.")
}
