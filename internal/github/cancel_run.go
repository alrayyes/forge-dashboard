package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

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

// attachRuns names the workflow run behind each queued or running check, so
// the pipeline dialog can offer to cancel it. It reads the commit's runs and
// the jobs of each unfinished one, and only when a check is still going, so a
// finished pipeline costs nothing extra. The names are a convenience: a read
// that fails leaves the checks as they were, never an error.
func (c *Client) attachRuns(ctx context.Context, owner, name, sha string, checks []dashboard.Check) {
	if !slices.ContainsFunc(checks, jobStillGoing) {
		return
	}

	byJob := c.activeRunJobs(ctx, owner, name, sha)
	for i := range checks {
		if ref, ok := byJob[checks[i].JobID]; ok && jobStillGoing(checks[i]) {
			checks[i].RunID, checks[i].RunName, checks[i].RunNumber = ref.id, ref.name, ref.number
		}
	}
}

// activeRunJobs maps the id of each job of an unfinished run on sha to its run.
func (c *Client) activeRunJobs(ctx context.Context, owner, name, sha string) map[int64]runRef {
	byJob := map[int64]runRef{}

	for _, run := range c.unfinishedRuns(ctx, owner, name, sha) {
		jobsPath := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/jobs", owner, name, run.GetID())
		slog.Debug("github request", "method", http.MethodGet, "url", jobsPath)
		jobOpts := &ghsdk.ListWorkflowJobsOptions{}
		jobOpts.PerPage = perPage
		jobs, jobsResp, err := c.restClient.Actions.ListWorkflowJobs(ctx, owner, name, run.GetID(), jobOpts)
		if err != nil {
			slog.Debug("github workflow jobs unavailable", "path", jobsPath, "err", err)

			continue
		}
		c.recordRESTSuccess(ctx, http.MethodGet, jobsPath, jobsResp)
		for _, job := range jobs.Jobs {
			byJob[job.GetID()] = runRef{id: run.GetID(), name: run.GetName(), number: int64(run.GetRunNumber())}
		}
	}

	return byJob
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
