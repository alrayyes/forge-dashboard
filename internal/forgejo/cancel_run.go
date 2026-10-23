package forgejo

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
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
func withRun(check dashboard.Check, runID int64, runName string) dashboard.Check {
	if check.State == dashboard.CheckRunning || check.State == dashboard.CheckQueued {
		check.RunID, check.RunName = runID, runName
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
