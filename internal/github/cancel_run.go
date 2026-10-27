package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
)

// CancelRun implements dashboard.RunCanceler: it asks GitHub to cancel one
// workflow run, and with it every job and step of the run. GitHub has no route
// that cancels a single job. A run that already finished is refused with
// GitHub's own sentence, as is a token without write access to Actions.
func (c *Client) CancelRun(ctx context.Context, owner, name string, runID int64) error {
	path := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/cancel", owner, name, runID)
	slog.Debug("github request", "method", http.MethodPost, "url", path)
	resp, err := c.restClient.Actions.CancelWorkflowRunByID(ctx, owner, name, runID)
	if err != nil {
		// A 202 with no body is the success the SDK reports as an AcceptedError.
		if _, accepted := errors.AsType[*ghsdk.AcceptedError](err); accepted {
			c.recordRESTSuccess(ctx, http.MethodPost, path, resp)

			return nil
		}

		return asClientError(c.restError(ctx, http.MethodPost, path, err))
	}
	c.recordRESTSuccess(ctx, http.MethodPost, path, resp)

	return nil
}

// activeRunStatuses are the workflow run statuses of a run that has not
// finished and is being worked on: the ones a cancel can still stop. A run held
// for approval ("waiting") has no job going and is left out.
var activeRunStatuses = map[string]bool{"queued": true, "in_progress": true}

// jobStillGoing reports whether ch is a job that is queued or running.
func jobStillGoing(ch dashboard.Check) bool {
	return ch.JobID != 0 && (ch.State == dashboard.CheckRunning || ch.State == dashboard.CheckQueued)
}

// runRef is the workflow run a job belongs to.
type runRef struct {
	id     int64
	name   string
	number int64
}

func refOf(run *ghsdk.WorkflowRun) runRef {
	return runRef{id: run.GetID(), name: run.GetName(), number: int64(run.GetRunNumber())}
}

// jobRunID is the id of the workflow run in an Actions job's page address
// ("/actions/runs/<run>/job/<job>"), 0 for any other address.
var jobRunID = regexp.MustCompile(`/actions/runs/(\d+)/job/\d+`)

func runIDOf(jobURL string) int64 {
	m := jobRunID.FindStringSubmatch(jobURL)
	if m == nil {
		return 0
	}
	id, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0
	}

	return id
}

// attachRuns names the workflow run behind each check: the unit a cancel acts
// on while a job is going, and the identity of a finished job's run. A going
// job is matched to its run by the run's job list, which only unfinished runs
// are asked for. A finished job carries its run's id in its page address, so
// its run's name and number come from one more list of the commit's completed
// runs, read only when such a job needs it. The names are a convenience: a read
// that fails leaves the checks as they were, never an error.
func (c *Client) attachRuns(ctx context.Context, owner, name, sha string, checks []dashboard.Check) {
	known := c.attachGoingRuns(ctx, owner, name, sha, checks)

	// The runs still going are known already; a job of one of the others needs
	// the commit's completed runs.
	if slices.ContainsFunc(checks, func(ch dashboard.Check) bool {
		id := runIDOf(ch.URL)
		_, ok := known[id]

		return ch.RunID == 0 && id != 0 && !ok
	}) {
		for _, run := range c.completedRuns(ctx, owner, name, sha) {
			known[run.GetID()] = refOf(run)
		}
	}
	for i := range checks {
		if ref, ok := known[runIDOf(checks[i].URL)]; ok && checks[i].RunID == 0 {
			setRun(&checks[i], ref)
		}
	}
}

// attachGoingRuns names the run of each queued or running job, and returns the
// unfinished runs it read. Without a going job it reads nothing.
func (c *Client) attachGoingRuns(ctx context.Context, owner, name, sha string, checks []dashboard.Check) map[int64]runRef {
	known := map[int64]runRef{}
	if !slices.ContainsFunc(checks, jobStillGoing) {
		return known
	}

	byJob := map[int64]runRef{}
	for _, run := range c.unfinishedRuns(ctx, owner, name, sha) {
		known[run.GetID()] = refOf(run)
		maps.Copy(byJob, c.runJobs(ctx, owner, name, run))
	}
	for i := range checks {
		if ref, ok := byJob[checks[i].JobID]; ok && jobStillGoing(checks[i]) {
			setRun(&checks[i], ref)
		}
	}

	return known
}

func setRun(ch *dashboard.Check, ref runRef) {
	ch.RunID, ch.RunName, ch.RunNumber = ref.id, ref.name, ref.number
}

// runJobs maps the id of each job of run to the run.
func (c *Client) runJobs(ctx context.Context, owner, name string, run *ghsdk.WorkflowRun) map[int64]runRef {
	byJob := map[int64]runRef{}

	jobsPath := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/jobs", owner, name, run.GetID())
	slog.Debug("github request", "method", http.MethodGet, "url", jobsPath)
	jobOpts := &ghsdk.ListWorkflowJobsOptions{}
	jobOpts.PerPage = perPage
	jobs, jobsResp, err := c.restClient.Actions.ListWorkflowJobs(ctx, owner, name, run.GetID(), jobOpts)
	if err != nil {
		slog.Debug("github workflow jobs unavailable", "path", jobsPath, "err", err)

		return byJob
	}
	c.recordRESTSuccess(ctx, http.MethodGet, jobsPath, jobsResp)
	for _, job := range jobs.Jobs {
		byJob[job.GetID()] = refOf(run)
	}

	return byJob
}

// completedRuns lists the finished workflow runs of sha, one request.
func (c *Client) completedRuns(ctx context.Context, owner, name, sha string) []*ghsdk.WorkflowRun {
	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	slog.Debug("github request", "method", http.MethodGet, "url", runsPath, "status", "completed")
	opts := &ghsdk.ListWorkflowRunsOptions{HeadSHA: sha, Status: "completed"}
	opts.PerPage = perPage
	runs, resp, err := c.restClient.Actions.ListRepositoryWorkflowRuns(ctx, owner, name, opts)
	if err != nil {
		slog.Debug("github workflow runs unavailable", "path", runsPath, "status", "completed", "err", err)

		return nil
	}
	c.recordRESTSuccess(ctx, http.MethodGet, runsPath, resp)

	return runs.WorkflowRuns
}

// unfinishedRuns lists the queued and running workflow runs of sha. It asks
// the forge for each status in turn, so the active runs come back on the first
// page however many finished runs the commit has. A status that fails to read
// leaves the other's runs, never an error.
func (c *Client) unfinishedRuns(ctx context.Context, owner, name, sha string) []*ghsdk.WorkflowRun {
	var active []*ghsdk.WorkflowRun
	seen := map[int64]bool{}

	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	for _, status := range []string{"queued", "in_progress"} {
		slog.Debug("github request", "method", http.MethodGet, "url", runsPath, "status", status)
		opts := &ghsdk.ListWorkflowRunsOptions{HeadSHA: sha, Status: status}
		opts.PerPage = perPage
		runs, resp, err := c.restClient.Actions.ListRepositoryWorkflowRuns(ctx, owner, name, opts)
		if err != nil {
			slog.Debug("github workflow runs unavailable", "path", runsPath, "status", status, "err", err)

			continue
		}
		c.recordRESTSuccess(ctx, http.MethodGet, runsPath, resp)
		for _, run := range runs.WorkflowRuns {
			if activeRunStatuses[run.GetStatus()] && !seen[run.GetID()] {
				seen[run.GetID()] = true
				active = append(active, run)
			}
		}
	}

	return active
}
