package forgejo

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// errNothingToRerun is why a rerun found no failed Actions run on the pull
// request's head commit. Shown to a person, so it reads as a sentence and
// carries no "forgejo: " prefix the page would swap for a generic one.
var errNothingToRerun = errors.New("no failed job to rerun on this pull request")

// RerunFailedChecks implements dashboard.ChecksRerunner: it finds the Actions
// runs on the pull request's head commit, and asks Forgejo to rerun the failed
// jobs of each run that failed, once per run. A commit status doesn't say which
// run it came from, so the runs are looked up by commit instead. A status with
// no run behind it (an external CI) isn't there to find and is skipped.
//
// The rerun is a raw request, not the SDK's RerunRepoActionRunFailedJobs: the
// SDK drops the body of a refusal, and Forgejo's own reason (a token without
// the Actions scope, an instance without the route) is what a person needs.
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

	return c.rerunRuns(ctx, owner, name, failed)
}

// errNothingToRerunOnBranch is errNothingToRerun for a default branch.
var errNothingToRerunOnBranch = errors.New("no failed job to rerun on this branch")

// RerunFailedDefaultBranchChecks implements dashboard.DefaultBranchRerunner: it
// asks Forgejo to rerun the failed jobs of every failed Actions run on the
// newest commit of owner/name's default branch that has one, the commit the
// Main branches row reports.
func (c *Client) RerunFailedDefaultBranchChecks(ctx context.Context, owner, name string) error {
	c = c.withContext(ctx)

	repoPath := fmt.Sprintf("/repos/%s/%s", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", repoPath)
	repo, resp, err := c.sdk.GetRepo(owner, name)
	if err != nil {
		return c.forgejoError(ctx, http.MethodGet, repoPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, repoPath, resp.StatusCode, requestlog.OutcomeSuccess)

	var failed []int64
	if repo.DefaultBranch != "" {
		runs, err := c.branchRuns(ctx, dashboard.RepoRef{
			FullName: owner + "/" + name, Owner: owner, Name: name, DefaultBranch: repo.DefaultBranch,
		})
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

	return c.rerunRuns(ctx, owner, name, failed)
}

// rerunRuns asks Forgejo to rerun the failed jobs of each run in ids.
func (c *Client) rerunRuns(ctx context.Context, owner, name string, ids []int64) error {
	for _, runID := range ids {
		rerunPath := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/rerun-failed-jobs", owner, name, runID)
		slog.Debug("forgejo request", "method", http.MethodPost, "url", rerunPath)
		_, resp, err := c.rawRequest(ctx, http.MethodPost, rerunPath, nil)
		if err != nil {
			return c.forgejoError(ctx, http.MethodPost, rerunPath, resp, err)
		}
	}

	return nil
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
