package forgejo

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// ReadMainBranch implements dashboard.MainBranchReader (#1224): the CI status
// of repo's default branch, from the Actions runs Forgejo lists for it. The
// newest commit with a run is the one that counts, and every workflow that ran
// on it is folded into one status, since a commit with a green lint and a red
// test is a broken main. Costs one list call, one more for the commit and, for
// a failed run only, one for its jobs.
//
// A repo with no default branch, no run, or an instance without Actions comes
// back as status none. A runs list that fails is an error, so the caller keeps
// the repo's earlier row rather than showing none.
func (c *Client) ReadMainBranch(ctx context.Context, repo dashboard.RepoRef) (dashboard.MainBranch, error) {
	row := dashboard.MainBranch{
		Branch: repo.DefaultBranch, Status: dashboard.MainBranchNone,
		FailingJobs: []string{}, RunURL: repo.URL,
	}
	if repo.DefaultBranch == "" {
		return row, nil
	}

	runs, err := c.branchRuns(ctx, repo)
	if err != nil {
		return row, err
	}
	if len(runs) == 0 {
		return row, nil
	}

	row.Status = mainBranchStatus(runs)
	row.Commit = c.branchCommit(ctx, repo, runs[0])
	if row.Status == dashboard.MainBranchFailed {
		failed := failedRuns(runs)
		row.FailingJobs = c.failingJobNames(ctx, repo, failed)
		row.RunURL = failed[0].HTMLURL
	} else if runs[0].HTMLURL != "" {
		row.RunURL = runs[0].HTMLURL
	}
	if row.Status != dashboard.MainBranchRunning {
		row.FinishedAt, row.DurationSeconds = runTimes(runs)
	}

	return row, nil
}

// branchRun is one entry of Forgejo's Actions runs list, decoded by hand: the
// SDK's ActionWorkflowRun expects GitHub's field names (head_sha, head_branch,
// started_at), none of which Forgejo sends, so every run came back with an
// empty commit and branch and the whole history folded into one verdict
// (#1264). Forgejo's names are recorded in testdata/actions_runs_master.json.
type branchRun struct {
	ID         int64     `json:"id"`
	Title      string    `json:"title"`
	WorkflowID string    `json:"workflow_id"`
	Ref        string    `json:"prettyref"` // the branch, "#N" for a pull request
	Event      string    `json:"event"`
	CommitSHA  string    `json:"commit_sha"`
	Status     string    `json:"status"`
	StartedAt  time.Time `json:"started"`
	StoppedAt  time.Time `json:"stopped"`
	HTMLURL    string    `json:"html_url"`
	Trigger    *struct {
		Login string `json:"login"`
	} `json:"trigger_user"`
}

// branchRuns is every Actions run on the newest commit that has one on repo's
// default branch, newest run first. Forgejo ignores the branch filter, so the
// branch is checked here, and pull request runs, whose ref is "#N", never match.
func (c *Client) branchRuns(ctx context.Context, repo dashboard.RepoRef) ([]*branchRun, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/runs", repo.Owner, repo.Name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, fmt.Sprintf("%s?page=1&limit=%d&branch=%s", path, pageLimit, url.QueryEscape(repo.DefaultBranch)), nil)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusNotFound {
			// An instance too old for /actions/runs, or one with Actions off.
			c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, string(dashboard.ForgeErrorNotFound))

			return nil, nil
		}

		return nil, c.forgejoError(ctx, http.MethodGet, path, resp, err)
	}

	var list struct {
		WorkflowRuns []*branchRun `json:"workflow_runs"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("forgejo: unmarshal action runs response: %w", err)
	}

	var runs []*branchRun
	for _, r := range list.WorkflowRuns {
		if r.Ref == repo.DefaultBranch && !strings.HasPrefix(r.Event, "pull_request") {
			runs = append(runs, r)
		}
	}
	slices.SortFunc(runs, func(a, b *branchRun) int { return int(b.ID - a.ID) })
	if len(runs) == 0 {
		return nil, nil
	}

	sha := runs[0].CommitSHA

	return slices.DeleteFunc(runs, func(r *branchRun) bool { return r.CommitSHA != sha }), nil
}

// mainBranchStatus folds the runs of one commit into one status. A real failure
// wins over a run still going; runs that were only cancelled count as failed
// when nothing is left running to replace them, the rule a pull request's
// rollup follows (#722).
func mainBranchStatus(runs []*branchRun) dashboard.MainBranchStatus {
	var failed, cancelled, running bool
	for _, r := range runs {
		switch checkStateFromWorkflowStatus(r.Status) {
		case dashboard.CheckFailure:
			failed = true
		case dashboard.CheckCancelled:
			cancelled = true
		case dashboard.CheckRunning, dashboard.CheckQueued:
			running = true
		}
	}
	switch {
	case failed:
		return dashboard.MainBranchFailed
	case running:
		return dashboard.MainBranchRunning
	case cancelled:
		return dashboard.MainBranchFailed
	default:
		return dashboard.MainBranchPassed
	}
}

// failedRuns is the runs that broke the commit: the ones that failed, or, when
// the only trouble is cancelled runs, those.
func failedRuns(runs []*branchRun) []*branchRun {
	failed := slices.DeleteFunc(slices.Clone(runs), func(r *branchRun) bool {
		return checkStateFromWorkflowStatus(r.Status) != dashboard.CheckFailure
	})
	if len(failed) > 0 {
		return failed
	}

	return slices.DeleteFunc(slices.Clone(runs), func(r *branchRun) bool {
		return checkStateFromWorkflowStatus(r.Status) != dashboard.CheckCancelled
	})
}

// failingJobNames names the failed jobs of each run, or the run's workflow file
// when its jobs can't be read or none shows as failed.
func (c *Client) failingJobNames(ctx context.Context, repo dashboard.RepoRef, runs []*branchRun) []string {
	names := []string{}
	for _, run := range runs {
		var failing []string
		jobs, err := c.listActionRunJobs(ctx, repo.Owner, repo.Name, run.ID)
		if err != nil {
			slog.Warn("list default-branch run jobs failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "run", run.ID, "error", err)
		}
		wanted := checkStateFromWorkflowStatus(run.Status)
		for _, j := range jobs {
			if checkStateFromWorkflowStatus(j.Status) == wanted {
				failing = append(failing, j.Name)
			}
		}
		if len(failing) == 0 {
			workflow, _, _ := strings.Cut(run.WorkflowID, "@")
			failing = []string{workflow}
		}
		names = append(names, failing...)
	}

	return names
}

// branchCommit names the commit the runs are on, from the commit itself. A
// commit that can't be read falls back to the newest run's title and actor,
// which says less but still names it.
func (c *Client) branchCommit(ctx context.Context, repo dashboard.RepoRef, run *branchRun) *dashboard.MainBranchCommit {
	commit := &dashboard.MainBranchCommit{SHA: dashboard.ShortSHA(run.CommitSHA), Subject: run.Title}
	if run.Trigger != nil {
		commit.Author = run.Trigger.Login
	}

	c.setContext(ctx)
	path := fmt.Sprintf("/repos/%s/%s/git/commits/%s", repo.Owner, repo.Name, run.CommitSHA)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	got, resp, err := c.sdk.GetSingleCommit(repo.Owner, repo.Name, run.CommitSHA)
	if err != nil || got == nil || got.RepoCommit == nil {
		slog.Debug("read default-branch commit failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "error", err)

		return commit
	}
	c.recordRequest(ctx, http.MethodGet, path, resp.StatusCode, requestlog.OutcomeSuccess)

	subject, _, _ := strings.Cut(got.RepoCommit.Message, "\n")
	commit.Subject = subject
	switch {
	case got.Author != nil && got.Author.UserName != "":
		commit.Author = got.Author.UserName
	case got.RepoCommit.Author != nil && got.RepoCommit.Author.Name != "":
		commit.Author = got.RepoCommit.Author.Name
	}
	if got.RepoCommit.Author != nil {
		if at, err := time.Parse(time.RFC3339, got.RepoCommit.Author.Date); err == nil {
			commit.CommittedAt = &at
		}
	}

	return commit
}

// runTimes is when the last run finished and how long the commit's pipeline
// took, from the first start to that finish. Nil when no run has both times.
func runTimes(runs []*branchRun) (finished *time.Time, seconds *int) {
	var first, last time.Time
	for _, r := range runs {
		if r.StartedAt.IsZero() || r.StoppedAt.IsZero() {
			continue
		}
		if first.IsZero() || r.StartedAt.Before(first) {
			first = r.StartedAt
		}
		if r.StoppedAt.After(last) {
			last = r.StoppedAt
		}
	}
	if last.IsZero() {
		return nil, nil
	}
	d := max(int(last.Sub(first).Seconds()), 0)

	return &last, &d
}
