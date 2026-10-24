package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"path"
	"strings"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// CancelRun implements dashboard.RunCanceler: it asks Forgejo to cancel one
// Actions run, and with it every job of the run. Forgejo has no route that
// cancels a single job.
//
// The call is a raw request, not an SDK method (the SDK has none), and it
// keeps Forgejo's own reason on a refusal: a token without the Actions scope,
// a run that already finished, an instance without the route.
func (c *Client) CancelRun(ctx context.Context, owner, name string, runID int64) error {
	c = c.withContext(ctx)

	cancelPath := fmt.Sprintf("/repos/%s/%s/actions/runs/%d/cancel", owner, name, runID)
	slog.Debug("forgejo request", "method", http.MethodPost, "url", cancelPath)
	_, resp, err := c.rawRequest(ctx, http.MethodPost, cancelPath, nil)
	if err != nil {
		return c.forgejoError(ctx, http.MethodPost, cancelPath, resp, err)
	}

	return nil
}

// withRun marks check as a job of the run runID named runName when the job is
// still queued or running, the only state a cancel can still change.
func withRun(check dashboard.Check, runID int64, runName string, runNumber int64) dashboard.Check {
	if check.State == dashboard.CheckRunning || check.State == dashboard.CheckQueued {
		check.RunID, check.RunName, check.RunNumber = runID, runName, runNumber
	}

	return check
}

// workflowName is the workflow of run for a person: its file without the
// directory, the extension or the "@ref" suffix ("ci.yaml@refs/heads/main" is
// "ci"), else the run's title.
func workflowName(run *gitea.ActionWorkflowRun) string {
	file, _, _ := strings.Cut(run.Path, "@")
	stem := strings.TrimSuffix(path.Base(file), path.Ext(file))
	if stem == "" || stem == "." {
		return run.DisplayTitle
	}

	return stem
}

// listRunsForSHA lists the Actions runs of sha. Forgejo names a run by
// workflow_id, title and index_in_repo, while the SDK's ActionWorkflowRun reads
// path, display_title and run_number, which Forgejo doesn't send. So the list
// is decoded by hand and those fields filled from Forgejo's own; a server that
// does send the SDK's names keeps them. Only this call is hand-decoded: it is
// the one that shows a run's name and number, while the other runs-list reads
// (a re-run, the running split) use only ids and states, which the SDK reads
// fine. It logs the request and rawRequest records it, so the caller does neither.
func (c *Client) listRunsForSHA(ctx context.Context, owner, name, sha string) (*gitea.ActionWorkflowRunsResponse, *gitea.Response, error) {
	runsPath := fmt.Sprintf("/repos/%s/%s/actions/runs", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", runsPath)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, fmt.Sprintf("%s?limit=%d&head_sha=%s", runsPath, pageLimit, url.QueryEscape(sha)), nil)
	if err != nil {
		return nil, resp, err
	}

	var list struct {
		WorkflowRuns []struct {
			gitea.ActionWorkflowRun
			WorkflowID  string `json:"workflow_id"`
			Title       string `json:"title"`
			IndexInRepo int64  `json:"index_in_repo"`
		} `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, resp, fmt.Errorf("forgejo: unmarshal action runs response: %w", err)
	}

	out := &gitea.ActionWorkflowRunsResponse{}
	for _, entry := range list.WorkflowRuns {
		run := entry.ActionWorkflowRun
		if run.Path == "" {
			run.Path = entry.WorkflowID
		}
		if run.DisplayTitle == "" {
			run.DisplayTitle = entry.Title
		}
		if run.RunNumber == 0 {
			run.RunNumber = entry.IndexInRepo
		}
		out.WorkflowRuns = append(out.WorkflowRuns, &run)
	}
	out.TotalCount = int64(len(out.WorkflowRuns))

	return out, resp, nil
}
