package forgejo_test

import (
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Forgejo records a cancelled Actions job as a failure status, but nothing
// broke (#2846): the pipeline panel says Cancelled, so the row must not count it
// as failed. A status names its job in its target_url, as the live forge sends
// it: /<owner>/<repo>/actions/runs/<run number>/jobs/<position in the run>.

// jobStatus is the commit status of the job at position job of run number.
func jobStatus(state, context string, number, job int) map[string]string {
	return map[string]string{
		"status": state, "context": context,
		"target_url": fmt.Sprintf("/alrayyes/a/actions/runs/%d/jobs/%d", number, job),
	}
}

// actionsRun is one run as a live Forgejo lists it: its number is index_in_repo,
// and the commit is commit_sha, not head_sha.
func actionsRun(id, number int, status string, extra map[string]any) map[string]any {
	run := map[string]any{
		"id": id, "index_in_repo": number, "status": status, "event": "pull_request",
		"workflow_id": "pr-title.yml", "commit_sha": "cafef00d", "stopped": "2026-09-01T00:00:00Z",
	}
	maps.Copy(run, extra)

	return run
}

// forge is what a test serves: the statuses of the head commit, its runs (nil
// answers 500) and each run's jobs by run id, as their states in order. A jobs
// list holding "error" answers 500.
type forge struct {
	statuses []map[string]string
	runs     []map[string]any
	jobs     map[int][]string
	// jobNames overrides the names of a run's jobs, by run id. A job is
	// otherwise named for the status that points at it, as the forge does.
	jobNames map[int][]string
}

// jobsPageSize is how many jobs the fake forge serves a page when the request
// names no limit, as the live forge does.
const jobsPageSize = 30

// contextJob is the job name in a status context, "<workflow> / <job> (<event>)".
func contextJob(context string) string {
	_, rest, _ := strings.Cut(context, " / ")
	job, _, _ := strings.Cut(rest, " (")

	return job
}

// jobName is the name of job i of run id: an override, else the job the
// statuses name there, else a stand-in.
func (f forge) jobName(id, i int) string {
	if names := f.jobNames[id]; i < len(names) {
		return names[i]
	}
	for _, r := range f.runs {
		if r["id"] != id {
			continue
		}
		for _, st := range f.statuses {
			if strings.Contains(st["target_url"], fmt.Sprintf("/runs/%v/jobs/%d", r["index_in_repo"], i)) {
				return contextJob(st["context"])
			}
		}
	}

	return fmt.Sprintf("job%d", i)
}

// cancelledPassing is a commit with one passed job and a failed status for the
// first job of run 2, whose job state is given.
func cancelledPassing(job string) forge {
	return forge{
		statuses: []map[string]string{
			jobStatus("success", "ci / test (pull_request)", 1, 0),
			jobStatus("failure", "pr-title / check (pull_request_target)", 2, 0),
		},
		runs: []map[string]any{actionsRun(11, 1, "success", nil), actionsRun(12, 2, "cancelled", nil)},
		jobs: map[int][]string{11: {"success"}, 12: {job}},
	}
}

type served struct {
	client             *forgejo.Client
	jobReads, runReads *atomic.Int32
}

func (f forge) serve(t *testing.T) served {
	t.Helper()
	s := served{jobReads: &atomic.Int32{}, runReads: &atomic.Int32{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{
			"number": 12, "title": "t", "html_url": "https://git.example/alrayyes/a/pulls/12",
			"user": map[string]string{"login": "ryankes"}, "labels": []map[string]string{}, "mergeable": true,
			"created_at": "2026-09-01T00:00:00Z", "updated_at": "2026-09-02T00:00:00Z",
			"head": map[string]string{"sha": "cafef00d"}, "base": map[string]string{"sha": "abc"},
		}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/commits/cafef00d/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"state": "failure", "statuses": f.statuses})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/actions/runs", func(w http.ResponseWriter, _ *http.Request) {
		s.runReads.Add(1)
		if f.runs == nil {
			w.WriteHeader(http.StatusInternalServerError)

			return
		}
		writeJSON(t, w, map[string]any{"workflow_runs": f.runs})
	})
	for id, states := range f.jobs {
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/a/actions/runs/%d/jobs", id), func(w http.ResponseWriter, r *http.Request) {
			s.jobReads.Add(1)
			jobs := []map[string]any{}
			for i, state := range states {
				if state == "error" {
					w.WriteHeader(http.StatusInternalServerError)

					return
				}
				jobs = append(jobs, map[string]any{"name": f.jobName(id, i), "status": state, "completed_at": "2026-09-01T00:00:00Z"})
			}
			q := r.URL.Query()
			limit, err := strconv.Atoi(q.Get("limit"))
			if err != nil {
				limit = jobsPageSize
			}
			page, err := strconv.Atoi(q.Get("page"))
			if err != nil {
				page = 1
			}
			lo := min((page-1)*limit, len(jobs))
			writeJSON(t, w, jobs[lo:min(lo+limit, len(jobs))])
		})
	}
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	s.client = forgejo.NewClient(srv.URL, "test-token", "")

	return s
}

func (s served) pullRequest(t *testing.T) dashboard.PullRequest {
	t.Helper()
	prs, err := s.client.ListOpenPullRequests(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, prs, 1)

	return prs[0]
}

func (f forge) pullRequest(t *testing.T) dashboard.PullRequest {
	t.Helper()

	return f.serve(t).pullRequest(t)
}

func TestListOpenPullRequests_ACancelledJobIsNotCountedAsFailed(t *testing.T) {
	t.Parallel()

	got := cancelledPassing("cancelled").pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
}

func TestListOpenPullRequests_ACancelledJobDoesNotMakeTheRowFail(t *testing.T) {
	t.Parallel()

	got := cancelledPassing("cancelled").pullRequest(t)

	assert.Equal(t, dashboard.CISuccess, got.CI)
}

func TestListOpenPullRequests_AJobThatFailedStillCountsAsFailed(t *testing.T) {
	t.Parallel()

	got := cancelledPassing("failure").pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// Two jobs of one run, one cancelled and one failed: only the cancelled one is
// excused, whatever the jobs are called.
func TestListOpenPullRequests_ACancelledJobBesideARealFailureLeavesTheFailure(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses = append(f.statuses, jobStatus("failure", "pr-title / lint (pull_request_target)", 2, 1))
	f.jobs[12] = []string{"cancelled", "failure"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

func TestListOpenPullRequests_ACancelledJobBesideARealFailureStillFailsTheRow(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses = append(f.statuses, jobStatus("failure", "pr-title / lint (pull_request_target)", 2, 1))
	f.jobs[12] = []string{"cancelled", "failure"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CIFailure, got.CI)
}

func TestListOpenPullRequests_ACancelledJobBesideAPendingCheckLeavesTheRowPending(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses = append(f.statuses, map[string]string{"status": "pending", "context": "deploy / build (push)"})

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CIPending, got.CI)
}

func TestListOpenPullRequests_ACancelledJobBesideAWarningLeavesTheRowPending(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses = append(f.statuses, map[string]string{"status": "warning", "context": "lint (pull_request)"})

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CIPending, got.CI)
}

// The workflow's name: need not match its file: the job is found by the status's
// target_url, not by its context.
func TestListOpenPullRequests_AWorkflowNamedUnlikeItsFileStillExcusesACancelledJob(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "Title check / Check the title (pull_request_target)", 2, 0)

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
}

// When the jobs can't be read, the statuses stand as the forge sent them.
func TestListOpenPullRequests_UnreadableJobsLeaveTheFailureCounted(t *testing.T) {
	t.Parallel()

	got := cancelledPassing("error").pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

func TestListOpenPullRequests_RunsThatCantBeReadLeaveTheFailureCounted(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.runs = nil

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// One run whose jobs can't be read doesn't stop another run's cancelled job
// being excused.
func TestListOpenPullRequests_AnUnreadableRunDoesNotHideAnotherRunsCancelledJob(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses = append(f.statuses, jobStatus("failure", "audit / scan (push)", 3, 0))
	f.runs = append(f.runs, actionsRun(13, 3, "failure", nil))
	f.jobs[13] = []string{"error"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// A status that points at a run the list doesn't hold, such as one past the
// first page, stays failed.
func TestListOpenPullRequests_AStatusOfAnUnlistedRunStaysFailed(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "pr-title / check (pull_request_target)", 99, 0)

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// A run of another commit, which a forge ignoring head_sha would send, says
// nothing about this commit's status.
func TestListOpenPullRequests_ACancelledRunOfAnotherCommitDoesNotExcuseTheFailure(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.runs[1] = actionsRun(12, 2, "cancelled", map[string]any{"commit_sha": "deadbeef"})

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// An external CI's failure points at no Actions job, so nothing is asked of the
// forge for it.
func TestListOpenPullRequests_AnExternalFailureReadsNoRuns(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = map[string]string{"status": "failure", "context": "jenkins / build (main)", "target_url": "https://jenkins.example/job/1"}
	s := f.serve(t)

	s.pullRequest(t)

	assert.Zero(t, s.runReads.Load())
}

// The stopped time is read as text, so an odd value can't fail the run list.
func TestListOpenPullRequests_AnOddStoppedTimeDoesNotFailTheRunList(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.runs[1] = actionsRun(12, 2, "cancelled", map[string]any{"stopped": "yesterday"})

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
}

// A finished run's jobs never change, so a second poll doesn't read them again.
func TestListOpenPullRequests_AFinishedRunsJobsAreReadOnce(t *testing.T) {
	t.Parallel()
	s := cancelledPassing("cancelled").serve(t)

	s.pullRequest(t)
	s.pullRequest(t)

	assert.EqualValues(t, 1, s.jobReads.Load())
}

// A run that is going carries its commit as commit_sha, not head_sha, so the
// jobs that are running are still told from those that wait (#2848).
func TestListOpenPullRequests_ARunningJobOfARunListedByCommitSHACountsAsRunning(t *testing.T) {
	t.Parallel()
	f := forge{
		statuses: []map[string]string{
			jobStatus("pending", "ci / test (pull_request)", 1, 0),
			jobStatus("pending", "ci / lint (pull_request)", 1, 1),
		},
		runs: []map[string]any{actionsRun(11, 1, "running", map[string]any{"stopped": "0001-01-01T00:00:00Z"})},
		jobs: map[int][]string{11: {"running", "waiting"}},
	}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Running: 1, Waiting: 1}, got.Checks)
}

// A run with more jobs than one page: a status that points past the first page
// still finds its job.
func TestListOpenPullRequests_AJobPastTheFirstPageIsFound(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	states := make([]string, 60)
	for i := range states {
		states[i] = "success"
	}
	states[55] = "cancelled"
	f.jobs[12] = states
	f.statuses[1] = jobStatus("failure", "pr-title / shard-55 (pull_request_target)", 2, 55)

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1}, got.Checks)
}

// The run lists a cancelled job first, but the status numbers the job that
// failed: the position names the wrong job, so the failure stands.
func TestListOpenPullRequests_ARealFailureStaysFailedWhenTheJobOrderDiffers(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.statuses[1] = jobStatus("failure", "pr-title / lint (pull_request_target)", 2, 0)
	f.jobs[12] = []string{"cancelled", "failure"}
	f.jobNames = map[int][]string{12: {"check", "lint"}}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}

// A status whose context names one job while its position holds another excuses
// nothing, even when that other job was cancelled.
func TestListOpenPullRequests_AStatusThatNamesAnotherJobThanItsPositionIsNotExcused(t *testing.T) {
	t.Parallel()
	f := cancelledPassing("cancelled")
	f.jobNames = map[int][]string{12: {"build"}}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Failed: 1}, got.Checks)
}
