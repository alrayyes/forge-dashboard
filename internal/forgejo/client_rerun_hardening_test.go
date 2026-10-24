package forgejo_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
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
