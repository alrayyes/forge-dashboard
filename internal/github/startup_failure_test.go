package github_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const startupRunURL = "https://github.com/alrayyes/a/actions/runs/42"

// startupFailureRun is a workflow run that ended in startup_failure. GitHub
// creates no jobs for it, so no check run carries its name.
func startupFailureRun() map[string]any {
	return map[string]any{
		"id": 42, "workflow_id": 7, "name": "pr-title", "status": "completed",
		"conclusion": "startup_failure", "html_url": startupRunURL,
	}
}

// startupFailureServer is a blocked pull request whose required "check" never
// reported because the pr-title workflow, which provides it, failed to start
// (#3305). lookups counts the workflow-runs reads.
func startupFailureServer(t *testing.T, runs []map[string]any, lookups *atomic.Int32) *httptest.Server {
	t.Helper()

	var checkLookups atomic.Int32
	mux := checksMux(t, "BLOCKED", []string{"lint", "check"},
		[]map[string]any{completedRun("lint")}, &checkLookups)
	mux.HandleFunc("/repos/alrayyes/a/pulls/25", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"number": 25, "head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"ref": "main"}})
	})
	mux.HandleFunc("/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, r *http.Request) {
		lookups.Add(1)
		assert.Equal(t, "cafef00d", r.URL.Query().Get("head_sha"))
		writeJSON(t, w, map[string]any{"total_count": len(runs), "workflow_runs": runs})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

func TestListChecks_StartupFailureRun_IsListedAsAFailedWorkflow(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{startupFailureRun()}, &lookups)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 25)

	require.NoError(t, err)
	var found *dashboard.Check
	for i := range checks {
		if checks[i].Name == "pr-title" {
			found = &checks[i]
		}
	}
	require.NotNil(t, found, "the workflow that failed to start is a row of its own")
	assert.Equal(t, dashboard.CheckFailure, found.State)
	assert.Equal(t, "startup_failure", found.ReportedConclusion)
	assert.Equal(t, startupRunURL, found.URL)
	assert.Zero(t, found.JobID, "no job, so no log to read")
	assert.Zero(t, found.RunID, "no jobs to rerun or cancel")
}

func TestListChecks_RequiredCheckNoRunProvides_IsListedAsNotReported(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{startupFailureRun()}, &lookups)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 25)

	require.NoError(t, err)
	var missing []dashboard.Check
	for _, c := range checks {
		if c.NotReported {
			missing = append(missing, c)
		}
	}
	require.Len(t, missing, 1)
	assert.Equal(t, "check", missing[0].Name)
	require.NotNil(t, missing[0].Required)
	assert.True(t, *missing[0].Required)
	assert.Equal(t, dashboard.CheckQueued, missing[0].State)
}

func TestListChecks_RunsThatAllStarted_ListNothingExtra(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{
		{"id": 1, "workflow_id": 7, "name": "ci", "status": "completed", "conclusion": "success", "html_url": startupRunURL},
	}, &lookups)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 25)

	require.NoError(t, err)
	for _, c := range checks {
		assert.NotEqual(t, "startup_failure", c.ReportedConclusion)
		assert.NotEqual(t, "ci", c.Name)
	}
	assert.Equal(t, int32(1), lookups.Load(), "one workflow-runs read for the head")
}

func TestListChecks_AWorkflowThatStartedAgain_IsNotListedAsFailed(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	// Newest first: the rerun of the same workflow started and passed.
	srv := startupFailureServer(t, []map[string]any{
		{"id": 43, "workflow_id": 7, "name": "pr-title", "status": "completed", "conclusion": "success", "html_url": startupRunURL},
		startupFailureRun(),
	}, &lookups)

	checks, err := github.NewClient("test-token", "", srv.URL).ListChecks(t.Context(), "alrayyes", "a", 25)

	require.NoError(t, err)
	for _, c := range checks {
		assert.NotEqual(t, "startup_failure", c.ReportedConclusion)
	}
}

func TestListChecks_StartupFailureAnswer_IsRememberedForTheHead(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{startupFailureRun()}, &lookups)
	client := github.NewClient("test-token", "", srv.URL)

	for range 3 {
		checks, err := client.ListChecks(t.Context(), "alrayyes", "a", 25)
		require.NoError(t, err)
		assert.NotEmpty(t, checks)
	}

	assert.Equal(t, int32(1), lookups.Load(), "one read for three opens")
}

func TestFetch_StartupFailureRun_ReadsFailingAndCountsIt(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{startupFailureRun()}, &lookups)

	result := github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

	require.Len(t, result.PullRequests, 1)
	pr := result.PullRequests[0]
	assert.Equal(t, dashboard.CIFailure, pr.CI, "not a pending row beside Blocked")
	assert.Equal(t, 1, pr.Checks.Failed)
	assert.False(t, pr.AwaitingWorkflowApproval)
}

func TestFetch_StartupFailureRun_SharesTheHeadsOneRead(t *testing.T) {
	t.Parallel()

	var lookups atomic.Int32
	srv := startupFailureServer(t, []map[string]any{startupFailureRun()}, &lookups)
	client := github.NewClient("test-token", "", srv.URL)

	client.Fetch(t.Context())
	_, err := client.ListChecks(t.Context(), "alrayyes", "a", 25)

	require.NoError(t, err)
	assert.Equal(t, int32(1), lookups.Load())
}
