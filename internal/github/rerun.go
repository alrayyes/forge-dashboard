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

// errNothingToRerun is why a rerun found no failed Actions job on the pull
// request's head commit. Shown to a person, so it reads as a sentence.
var errNothingToRerun = errors.New("no failed GitHub Actions job to rerun on this pull request")

// RerunFailedChecks implements dashboard.ChecksRerunner (#698): it finds the
// failed or timed-out check runs on the pull request's head commit, maps each
// Actions job to its workflow run, and asks GitHub to rerun only the failed
// jobs of every such run, once per run. A check that isn't an Actions job
// (a third-party check, a legacy status) can't be rerun here and is skipped.
func (c *Client) RerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	prPath := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("github request", "method", http.MethodGet, "url", prPath)
	pr, prResp, err := c.restClient.PullRequests.Get(ctx, owner, name, number)
	if err != nil {
		return asClientError(c.restError(ctx, http.MethodGet, prPath, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, prPath, prResp)

	sha := pr.GetHead().GetSHA()
	runsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", runsPath)
	runs, runsResp, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, &ghsdk.ListCheckRunsOptions{PerPage: perPage})
	if err != nil {
		return asClientError(c.restError(ctx, http.MethodGet, runsPath, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, runsPath, runsResp)

	return c.rerunFailedRuns(ctx, owner, name, runs.CheckRuns, errNothingToRerun)
}

// errNothingToRerunOnBranch is errNothingToRerun for a default branch.
var errNothingToRerunOnBranch = errors.New("no failed GitHub Actions job to rerun on this branch")

// RerunFailedDefaultBranchChecks implements dashboard.DefaultBranchRerunner: it
// reruns the failed Actions jobs of the check runs on the commit
// ListDefaultBranchChecks shows, the one the Main branches row reports, as
// RerunFailedChecks does for a pull request.
func (c *Client) RerunFailedDefaultBranchChecks(ctx context.Context, owner, name, _ string) error {
	sha, _, err := c.defaultBranchChecks(ctx, owner, name)
	if err != nil {
		return err
	}
	if sha == "" {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerunOnBranch}
	}

	runsPath := fmt.Sprintf("/repos/%s/%s/commits/%s/check-runs", owner, name, sha)
	slog.Debug("github request", "method", http.MethodGet, "url", runsPath)
	runs, runsResp, err := c.restClient.Checks.ListCheckRunsForRef(ctx, owner, name, sha, &ghsdk.ListCheckRunsOptions{PerPage: perPage})
	if err != nil {
		return asClientError(c.restError(ctx, http.MethodGet, runsPath, err))
	}
	c.recordRESTSuccess(ctx, http.MethodGet, runsPath, runsResp)

	// A commit whose runs are held for approval has no check run, so nothing
	// is found to rerun: the held commit is shown, and it is the one refused.
	return c.rerunFailedRuns(ctx, owner, name, runs.CheckRuns, errNothingToRerunOnBranch)
}

// rerunFailedRuns maps the failed or timed-out check runs to their workflow
// runs and asks GitHub to rerun the failed jobs of each, once per workflow run.
// none is the conflict's sentence when no such run is found.
func (c *Client) rerunFailedRuns(ctx context.Context, owner, name string, checkRuns []*ghsdk.CheckRun, none error) error {
	var workflowRuns []int64
	for _, r := range checkRuns {
		if state := checkStateFromRun(r); state != dashboard.CheckFailure && state != dashboard.CheckTimedOut {
			continue
		}
		runID, ok := c.workflowRunOf(ctx, owner, name, r.GetID())
		if ok && !slices.Contains(workflowRuns, runID) {
			workflowRuns = append(workflowRuns, runID)
		}
	}
	if len(workflowRuns) == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: none}
	}

	for _, runID := range workflowRuns {
		rerunPath := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/rerun-failed-jobs", owner, name, runID)
		slog.Debug("github request", "method", http.MethodPost, "url", rerunPath)
		resp, err := c.restClient.Actions.RerunFailedJobsByID(ctx, owner, name, runID)
		if err != nil {
			return asClientError(c.restError(ctx, http.MethodPost, rerunPath, err))
		}
		c.recordRESTSuccess(ctx, http.MethodPost, rerunPath, resp)
	}

	return nil
}

// workflowRunOf is the workflow run that Actions job id belongs to. The bool
// is false when id isn't an Actions job the token can read.
func (c *Client) workflowRunOf(ctx context.Context, owner, name string, id int64) (int64, bool) {
	path := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d", owner, name, id)
	slog.Debug("github request", "method", http.MethodGet, "url", path)
	job, resp, err := c.restClient.Actions.GetWorkflowJobByID(ctx, owner, name, id)
	if err != nil {
		slog.Debug("github job unavailable", "path", path, "err", err)

		return 0, false
	}
	c.recordRESTSuccess(ctx, http.MethodGet, path, resp)

	return job.GetRunID(), job.GetRunID() != 0
}
