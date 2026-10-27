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
	"time"

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

// withRun names the run a check belongs to, whatever state it is in. Whether
// the run can still be cancelled is the page's call, from the check's state.
func withRun(check dashboard.Check, runID int64, runName string, runNumber int64) dashboard.Check {
	check.RunID, check.RunName, check.RunNumber = runID, runName, runNumber

	return check
}

// withRunFacts keeps what Forgejo said about the run itself: its status, which
// is also its conclusion once it has ended, and its start and end. An unset
// time is the zero time and is left nil. A run that gave no status gives none.
func withRunFacts(check dashboard.Check, status string, started, stopped time.Time) dashboard.Check {
	if status == "" {
		return check
	}

	facts := &dashboard.RunFacts{}
	facts.Status, facts.Conclusion = dashboard.StatusFacts(checkStateFromWorkflowStatus(status), reportedConclusion(status))
	if !started.IsZero() {
		facts.StartedAt = &started
	}
	if !stopped.IsZero() {
		facts.CompletedAt = &stopped
	}
	check.Run = facts

	return check
}

// withJobTimes sets the start and end the forge gives job. Forgejo answers an
// unset time as the zero time, which is left nil: a job that hasn't started or
// finished says nothing about it.
func withJobTimes(check dashboard.Check, job *gitea.ActionWorkflowJob) dashboard.Check {
	if !job.StartedAt.IsZero() {
		started := job.StartedAt
		check.StartedAt = &started
	}
	if !job.CompletedAt.IsZero() {
		completed := job.CompletedAt
		check.CompletedAt = &completed
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
// workflow_id, title, index_in_repo, commit_sha and stopped, while the SDK's
// ActionWorkflowRun reads path, display_title, run_number, head_sha and
// completed_at, which Forgejo doesn't send. So the list is decoded by hand and
// those fields filled from Forgejo's own; a server that does send the SDK's
// names keeps them. It logs the request and rawRequest records it, so the caller
// does neither.
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
			CommitSHA   string `json:"commit_sha"`
			Started     string `json:"started"`
			Stopped     string `json:"stopped"`
		} `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, resp, fmt.Errorf("forgejo: unmarshal action runs response: %w", err)
	}

	out := &gitea.ActionWorkflowRunsResponse{TotalCount: int64(len(list.WorkflowRuns))}
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
		// Read as text: an unset or odd value must not fail the whole list. A
		// rerun moves the start and not the stop, which is how it is told apart.
		fillTime(&run.CompletedAt, entry.Stopped)
		fillTime(&run.StartedAt, entry.Started)
		if run.HeadSha == "" {
			run.HeadSha = entry.CommitSHA
		}
		out.WorkflowRuns = append(out.WorkflowRuns, &run)
	}

	return out, resp, nil
}

// fillTime sets t from text when t is unset and the text is a time.
func fillTime(t *time.Time, text string) {
	if parsed, err := time.Parse(time.RFC3339, text); err == nil && t.IsZero() {
		*t = parsed
	}
}
