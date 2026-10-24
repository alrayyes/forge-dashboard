package forgejo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// errNothingToRerun is why a rerun found no failed Actions run on the pull
// request's head commit. Shown to a person, so it reads as a sentence and
// carries no "forgejo: " prefix the page would swap for a generic one.
var errNothingToRerun = errors.New("no failed job to rerun on this pull request")

// rerunJobPath is the route Forgejo offers to rerun one Actions job, as an
// OpenAPI path template. It first shipped in Forgejo 17.0.0, beside a route
// that reruns a whole run; 16 and earlier have no rerun route at all. The job
// route is the one used, so a job that passed doesn't go again. Forgejo
// restarts the jobs that need the one asked for along with it.
const rerunJobPath = "/repos/{owner}/{repo}/actions/jobs/{job_id}/rerun"

// firstRerunMajor is the first Forgejo major version with rerunJobPath.
const firstRerunMajor = 17

// firstForgejoMajor is the first major version only a Forgejo reports. Before
// it Forgejo numbered itself like the Gitea it forked, so a 1.x could be either
// and the rerun is left to the forge.
const firstForgejoMajor = 7

// errNoRerunRoute is why a rerun on a Forgejo older than firstRerunMajor never
// reaches the forge. Shown to a person, so it reads as a sentence.
var errNoRerunRoute = errors.New("This Forgejo is older than version 17 and has no way to rerun checks. Rerun them on the forge.") //nolint:staticcheck,revive // shown to a person

// RerunChecksBlockedReason implements dashboard.RerunChecksBlocker: why this
// instance can't rerun checks, or "" when it can or its version isn't known.
// It never waits on the network. The version is read in the background the
// first time it is asked for, read again after an hour while it blocks, and
// retried after a failed read; until a read lands the rerun is left to the
// forge.
func (c *Client) RerunChecksBlockedReason() string {
	if major, ok := c.serverMajor(); ok && major < firstRerunMajor {
		return errNoRerunRoute.Error()
	}

	return ""
}

// rerunBlocked is the refusal for an instance with no rerun route, or nil.
// A stale answer is read again under the click's own context first.
func (c *Client) rerunBlocked(ctx context.Context) error {
	if major, ok := c.serverMajorFor(ctx); !ok || major >= firstRerunMajor {
		return nil
	}

	return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNoRerunRoute}
}

// RerunFailedChecks implements dashboard.ChecksRerunner: it finds the Actions
// runs on the pull request's head commit, reads the jobs of each run that
// failed, and asks Forgejo to rerun each job that failed. A commit status
// doesn't say which run it came from, so the runs are looked up by commit
// instead. A status with no run behind it (an external CI) isn't there to find
// and is skipped.
//
// The rerun is a raw request, not an SDK call: the SDK drops the body of a
// refusal, and Forgejo's own reason (a token without the Actions scope, an
// instance without the route) is what a person needs.
func (c *Client) RerunFailedChecks(ctx context.Context, owner, name string, number int) error {
	c = c.withContext(ctx)
	prPath := fmt.Sprintf("/repos/%s/%s/pulls/%d", owner, name, number)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", prPath)
	pr, resp, err := c.sdk.GetPullRequest(owner, name, int64(number))
	if err != nil {
		return c.forgejoError(ctx, http.MethodGet, prPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, prPath, resp.StatusCode, requestlog.OutcomeSuccess)

	var sha string
	if pr.Head != nil {
		sha = pr.Head.Sha
	}
	failed, err := c.failedRunIDs(ctx, owner, name, sha)
	if err != nil {
		return err
	}
	if len(failed) == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerun}
	}
	n, err := c.rerunFailedJobs(ctx, owner, name, failed)
	if err != nil {
		return err
	}
	if n == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerun}
	}

	return nil
}

// errNothingToRerunOnBranch is errNothingToRerun for a default branch.
var errNothingToRerunOnBranch = errors.New("no failed job to rerun on this branch")

// RerunFailedDefaultBranchChecks implements dashboard.DefaultBranchRerunner: it
// asks Forgejo to rerun the failed jobs of every failed Actions run on the
// newest commit of owner/name's default branch that has one, the commit the
// Main branches row reports. The row names the branch, so the repository isn't
// read to learn it.
func (c *Client) RerunFailedDefaultBranchChecks(ctx context.Context, owner, name, defaultBranch string) error {
	c = c.withContext(ctx)
	var failed []int64
	if defaultBranch != "" {
		runs, err := c.branchRunsList(ctx, dashboard.RepoRef{
			FullName: owner + "/" + name, Owner: owner, Name: name, DefaultBranch: defaultBranch,
		}, true)
		if err != nil {
			return err
		}
		for _, run := range runs {
			if checkStateFromWorkflowStatus(run.Status) == dashboard.CheckFailure {
				failed = append(failed, run.ID)
			}
		}
	}
	if len(failed) == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerunOnBranch}
	}
	n, err := c.rerunFailedJobs(ctx, owner, name, failed)
	if err != nil {
		return err
	}
	if n == 0 {
		return &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errNothingToRerunOnBranch}
	}

	return nil
}

// rerunFailedJobs asks Forgejo to rerun each failed job of each run in ids, and
// says how many it asked for. A run's jobs are read once. Forgejo restarts the
// jobs that need a rerun job along with it, and refuses to rerun one that is
// going again, so before each job after the first the run's jobs are read
// again and a job that is no longer failed is left alone.
func (c *Client) rerunFailedJobs(ctx context.Context, owner, name string, ids []int64) (int, error) {
	if err := c.rerunBlocked(ctx); err != nil {
		return 0, err
	}
	asked := 0
	for _, runID := range ids {
		jobs, err := c.listActionRunJobs(ctx, owner, name, runID)
		if err != nil {
			return asked, err
		}
		failed := failedJobIDs(jobs)
		for i, jobID := range failed {
			if i > 0 {
				if jobs, err = c.listActionRunJobs(ctx, owner, name, runID); err != nil {
					return asked, err
				}
				if !slices.Contains(failedJobIDs(jobs), jobID) {
					continue
				}
			}
			rerunPath := fmt.Sprintf("/repos/%s/%s/actions/jobs/%d/rerun", owner, name, jobID)
			slog.Debug("forgejo request", "method", http.MethodPost, "url", rerunPath)
			if _, resp, err := c.rawRequest(ctx, http.MethodPost, rerunPath, nil); err != nil {
				return asked, c.forgejoError(ctx, http.MethodPost, rerunPath, resp, err)
			}
			asked++
		}
	}

	return asked, nil
}

// failedJobIDs is the id of every job in jobs that failed.
func failedJobIDs(jobs []*gitea.ActionWorkflowJob) []int64 {
	var ids []int64
	for _, j := range jobs {
		if checkStateFromWorkflowStatus(j.Status) == dashboard.CheckFailure {
			ids = append(ids, j.ID)
		}
	}

	return ids
}

// failedRunIDs is the id of every Actions run on commit sha that failed. A
// commit nobody can name has none.
func (c *Client) failedRunIDs(ctx context.Context, owner, name, sha string) ([]int64, error) {
	c = c.withContext(ctx)
	if sha == "" {
		return nil, nil
	}
	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", runsPath)
	runs, resp, err := c.sdk.ListRepoActionRuns(owner, name, gitea.ListRepoActionRunsOptions{
		PageSize: pageLimit,
		HeadSHA:  sha,
	})
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, runsPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, runsPath, resp.StatusCode, requestlog.OutcomeSuccess)

	var ids []int64
	for _, run := range runs.WorkflowRuns {
		if checkStateFromWorkflowStatus(run.Status) == dashboard.CheckFailure {
			ids = append(ids, run.ID)
		}
	}

	return ids, nil
}
