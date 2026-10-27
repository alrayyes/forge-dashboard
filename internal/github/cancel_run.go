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
	id      int64
	name    string
	number  int64
	attempt int64
	// facts is what the run itself reported; nil for a run only the job's
	// address names.
	facts *dashboard.RunFacts
}

func refOf(run *ghsdk.WorkflowRun) runRef {
	return runRef{
		id: run.GetID(), name: run.GetName(), number: int64(run.GetRunNumber()), attempt: int64(run.GetRunAttempt()),
		facts: runFacts(run),
	}
}

// runFacts keeps the run's own status, conclusion and start as the forge gave
// them. GitHub has no completion time for a run, so CompletedAt stays nil
// rather than borrowing the last update. A status outside the four the page
// knows (requested, pending) is a run that has not started, so it reads queued.
func runFacts(run *ghsdk.WorkflowRun) *dashboard.RunFacts {
	f := &dashboard.RunFacts{Conclusion: dashboard.CheckConclusion(run.GetConclusion())}
	switch status := dashboard.CheckStatus(run.GetStatus()); status {
	case dashboard.CheckStatusCompleted, dashboard.CheckStatusInProgress, dashboard.CheckStatusWaiting:
		f.Status = status
	default:
		f.Status = dashboard.CheckStatusQueued
	}
	if t := run.RunStartedAt; t != nil && !t.IsZero() {
		started := t.Time
		f.StartedAt = &started
	}

	return f
}

// jobRunID matches an Actions job's page address,
// "/actions/runs/<run>/job/<job>", with an "/attempts/<n>" after the run when
// the page is one attempt's. Group 1 is the run, group 2 the attempt.
var jobRunID = regexp.MustCompile(`/actions/runs/(\d+)(?:/attempts/(\d+))?/job/\d+`)

// runIDOf is the id of the workflow run in an Actions job's page address, 0
// for any other address.
func runIDOf(jobURL string) int64 {
	id, _ := runAndAttemptOf(jobURL)

	return id
}

// runAndAttemptOf is the run and the attempt an Actions job's page address
// names. The attempt is 0 when the address doesn't carry one, and both are 0
// for any other address.
func runAndAttemptOf(jobURL string) (run, attempt int64) {
	m := jobRunID.FindStringSubmatch(jobURL)
	if m == nil {
		return 0, 0
	}
	run, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, 0
	}
	if m[2] != "" {
		attempt, _ = strconv.ParseInt(m[2], 10, 64)
	}

	return run, attempt
}

// attachRuns names the workflow run behind each check: the unit a cancel acts
// on while a job is going, and the identity of a finished job's run. A going
// job is matched to its run by the run's job list, which only unfinished runs
// are asked for. A finished job carries its run's id in its page address, so
// its run's name and number come from one more list of the commit's completed
// runs, read only when such a job needs it. The id of a finished job's run is
// set whenever its address gives one; the name and number are a convenience,
// and a read that fails leaves them empty, never an error.
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
		id, attempt := runAndAttemptOf(checks[i].URL)
		if checks[i].RunID != 0 || id == 0 {
			continue
		}
		// The id and the attempt are facts of the address; the name, number and
		// the run's latest attempt need the lookup.
		ref, ok := known[id]
		if !ok {
			ref = runRef{id: id}
		}
		if attempt != 0 {
			if attempt != ref.attempt {
				// The lists describe the run's latest attempt only.
				ref.facts = nil
			}
			ref.attempt = attempt
		}
		setRun(&checks[i], ref)
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
	ch.RunID, ch.RunName, ch.RunNumber, ch.RunAttempt = ref.id, ref.name, ref.number, ref.attempt
	ch.Run = ref.facts
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
