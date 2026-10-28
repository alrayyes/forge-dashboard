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

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
)

// ReadMainBranch implements dashboard.MainBranchReader (#1224): the CI status
// of repo's default branch, from the Actions runs Forgejo lists for it. The
// newest commit with a run is the one that counts, and every workflow that ran
// on it is folded into one status, since a commit with a green lint and a red
// test is a broken main. The pill counts the commit's jobs, not its runs. Costs
// one list call, one more for the commit and one for the jobs of each run,
// except a finished run's, which are read once and kept.
//
// A repo with no default branch, no run, or an instance without Actions comes
// back as status none. A runs list that fails is an error, so the caller keeps
// the repo's earlier row rather than showing none.
//
// With an advisory scanner set (SetAdvisoryScanner) the row also carries the
// repo's open dependency advisories, read from its lockfiles and remembered for
// fifteen minutes (see advisoriesFor).
func (c *Client) ReadMainBranch(ctx context.Context, repo dashboard.RepoRef) (dashboard.MainBranch, error) {
	row, err := c.readBranchRuns(ctx, repo)
	if err != nil {
		return row, err
	}
	if repo.DefaultBranch != "" {
		row.Advisories = c.advisoriesFor(ctx, repo)
	}

	return row, nil
}

// readBranchRuns is ReadMainBranch without the advisories.
func (c *Client) readBranchRuns(ctx context.Context, repo dashboard.RepoRef) (dashboard.MainBranch, error) {
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

	jobs := c.runJobs(ctx, repo, runs)
	runs = settledRuns(runs, jobs)
	row.Status = mainBranchStatus(runs)
	row.Checks = countChecks(branchChecks(runs, jobs))
	row.Commit = c.branchCommit(ctx, repo, runs[0])
	switch {
	case row.Status == dashboard.MainBranchFailed:
		failed := failedRuns(runs)
		row.FailingJobs = failingJobNames(failed, jobs)
		row.RunURL = failed[0].HTMLURL
	case row.Status == dashboard.MainBranchCancelled:
		// Nothing failed, so no job is named; the link is the cancelled run.
		row.RunURL = failedRuns(runs)[0].HTMLURL
	case runs[0].HTMLURL != "":
		row.RunURL = runs[0].HTMLURL
	}
	if row.Status != dashboard.MainBranchRunning {
		row.FinishedAt, row.DurationSeconds = runTimes(runs)
	}

	return row, nil
}

// ListDefaultBranchChecks implements dashboard.DefaultBranchChecker: the jobs of
// every Actions run on the newest commit of owner/name's default branch that has
// one, the commit ReadMainBranch reports, gathered the way it gathers them and
// listed as it counts them (branchChecks). Fetched on demand. A repo with no
// default branch, or no run on it, has none, as its row reads none; a failed
// lookup is an error. "Required" is a pull request's base-branch notion and
// stays unknown.
//
// The list is the pill's, on purpose: it has no commit-status or commit-scoped
// run fallback, since a Forgejo default branch's checks are its Actions runs
// and the pill counts nothing else. A job list that can't be read gives the
// run as one check, here as in the count, rather than an error that would hide
// the rest of the pipeline.
func (c *Client) ListDefaultBranchChecks(ctx context.Context, owner, name string) ([]dashboard.Check, error) {
	c = c.withContext(ctx)

	repoPath := fmt.Sprintf("/repos/%s/%s", owner, name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", repoPath)
	repo, resp, err := c.sdk.GetRepo(owner, name)
	if err != nil {
		return nil, c.forgejoError(ctx, http.MethodGet, repoPath, resp, err)
	}
	c.recordRequest(ctx, http.MethodGet, repoPath, resp.StatusCode, requestlog.OutcomeSuccess)
	if repo.DefaultBranch == "" {
		return nil, nil
	}

	ref := dashboard.RepoRef{FullName: owner + "/" + name, Owner: owner, Name: name, DefaultBranch: repo.DefaultBranch}
	runs, err := c.branchRuns(ctx, ref)
	if err != nil || len(runs) == 0 {
		return nil, err
	}

	// The same runs and jobs the row counts (see ReadMainBranch), so the list
	// and the pill can't describe different pipelines. branchRuns sorts newest
	// first and keeps one commit's runs, so runs[0] is the commit the row reports.
	jobs := c.runJobs(ctx, ref, runs)
	checks := branchChecks(runs, jobs)
	c.rememberFailedJobs(owner, name, checks, jobExcerptKeys(ref, jobs))

	return checks, nil
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
	Number     int64     `json:"index_in_repo"`
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
	return c.branchRunsList(ctx, repo, false)
}

// branchRunsList is branchRuns, where strict turns a 404 on the runs list (an
// instance too old for it, or with Actions off) into an error instead of "no
// runs". A rerun is strict: "no failed job" would be false when the list could
// not be read.
func (c *Client) branchRunsList(ctx context.Context, repo dashboard.RepoRef, strict bool) ([]*branchRun, error) {
	path := fmt.Sprintf("/repos/%s/%s/actions/runs", repo.Owner, repo.Name)
	slog.Debug("forgejo request", "method", http.MethodGet, "url", path)
	body, resp, err := c.rawRequest(ctx, http.MethodGet, fmt.Sprintf("%s?page=1&limit=%d&branch=%s", path, pageLimit, url.QueryEscape(repo.DefaultBranch)), nil)
	if err != nil {
		if !strict && resp != nil && resp.StatusCode == http.StatusNotFound {
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
		if r.Ref == repo.DefaultBranch && !isPullRequestEvent(r.Event) {
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
// wins over a run still going; runs that were only cancelled, with nothing left
// running to replace them, are Cancelled: nothing broke (#1950). This differs on
// purpose from a pull request's rollup (#722), which still reads them as failed.
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
		return dashboard.MainBranchCancelled
	default:
		return dashboard.MainBranchPassed
	}
}

// settledRuns is runs with each run the list still calls running, but whose jobs
// have all finished, read as finished. The runs list is read before the jobs, so
// a run can end in between; folding the status from the stale list would leave
// the row running beside counts that show nothing running. The run takes the
// state its jobs give it: failed if any failed, else cancelled if any was, else
// passed. A run with no readable jobs, or a job still going, is left as listed.
// The settled run takes its stop time from the latest job to complete, so the
// row keeps a finish time and duration. A job list as long as the forge's
// default page (jobsPageSize) may have been cut short, and a run can't be
// called over from a part of its jobs, so it is left as listed.
func settledRuns(runs []*branchRun, jobs map[int64][]*gitea.ActionWorkflowJob) []*branchRun {
	out := make([]*branchRun, len(runs))
	for i, r := range runs {
		out[i] = r
		list := jobs[r.ID]
		if len(list) == 0 || len(list) >= jobsPageSize || checkStateFromWorkflowStatus(r.Status) != dashboard.CheckRunning {
			continue
		}
		status, stopped, over := jobsOutcome(list)
		if !over {
			continue
		}
		settled := *r
		settled.StoppedAt = stopped
		settled.Status = status
		out[i] = &settled
	}

	return out
}

// jobsOutcome reads a run's finished jobs as the status the run ends in, and the
// latest time one completed. over is false while any job is running or queued.
func jobsOutcome(list []*gitea.ActionWorkflowJob) (status string, stopped time.Time, over bool) {
	var failed, cancelled bool
	for _, j := range list {
		if j.CompletedAt.After(stopped) {
			stopped = j.CompletedAt
		}
		switch checkStateFromWorkflowStatus(j.Status) {
		case dashboard.CheckRunning, dashboard.CheckQueued:
			return "", time.Time{}, false
		case dashboard.CheckFailure:
			failed = true
		case dashboard.CheckCancelled:
			cancelled = true
		case dashboard.CheckSuccess, dashboard.CheckSkipped:
		}
	}
	switch {
	case failed:
		return "failure", stopped, true
	case cancelled:
		return "cancelled", stopped, true
	}

	return "success", stopped, true
}

// jobsPageSize is how many jobs Forgejo answers with when no page size is asked
// for, the most a job list can hold before it is cut short.
const jobsPageSize = 30

// runJobs reads the jobs of every run, by run id. A run whose jobs can't be
// read is left out, and counts as one check (see branchChecks, countChecks).
// Which lists are kept for a repeat poll is readRunJobs's rule.
func (c *Client) runJobs(ctx context.Context, repo dashboard.RepoRef, runs []*branchRun) map[int64][]*gitea.ActionWorkflowJob {
	out := make(map[int64][]*gitea.ActionWorkflowJob, len(runs))
	for _, run := range runs {
		jobs, err := c.readRunJobs(ctx, repo.Owner, repo.Name, run.ID, run.Status, run.StartedAt, run.StoppedAt)
		if err != nil {
			slog.Warn("list default-branch run jobs failed", "forge", dashboard.ForgeForgejo, "repo", repo.FullName, "run", run.ID, "error", err)

			continue
		}
		out[run.ID] = jobs
	}

	return out
}

// jobsCatchUp is how long after a run finishes the forge may still answer an
// empty job list for it.
const jobsCatchUp = 5 * time.Minute

// isPassing reports whether status is one a run ends well in.
func isPassing(status string) bool {
	switch checkStateFromWorkflowStatus(status) {
	case dashboard.CheckSuccess, dashboard.CheckSkipped:
		return true
	case dashboard.CheckFailure, dashboard.CheckCancelled, dashboard.CheckRunning, dashboard.CheckQueued:
		return false
	}

	return false
}

// isFinished reports whether status is one a run ends in, by the same reading
// of the forge's words that checkStateFromWorkflowStatus gives the checks.
func isFinished(status string) bool {
	switch checkStateFromWorkflowStatus(status) {
	case dashboard.CheckSuccess, dashboard.CheckFailure, dashboard.CheckCancelled, dashboard.CheckSkipped:
		return true
	case dashboard.CheckRunning, dashboard.CheckQueued:
		return false
	}

	return false
}

// branchChecks is the checks of the commit's runs: each run's jobs, or, for a
// run with no readable job list, the run itself as one check named after its
// workflow, so a failed read shows less detail, never nothing. It is the one
// list both the pill's counts (countChecks) and the pipeline dialog come from,
// so a count never has a job behind it that the dialog hides.
func branchChecks(runs []*branchRun, jobs map[int64][]*gitea.ActionWorkflowJob) []dashboard.Check {
	var out []dashboard.Check
	for _, r := range runs {
		if list := jobs[r.ID]; len(list) > 0 {
			for _, j := range list {
				job := withRun(withJobTimes(dashboard.Check{
					Name:       j.Name,
					State:      branchJobState(r, j),
					URL:        j.HTMLURL,
					JobID:      j.ID,
					RunAttempt: j.RunAttempt,

					ReportedConclusion: reportedConclusion(j.Status),
				}, j), r.ID, runName(r), r.Number)
				out = append(out, withRunFacts(job, r.Status, r.StartedAt, r.StoppedAt))
			}

			continue
		}
		stand := withRun(dashboard.Check{
			Name: runName(r), State: checkStateFromWorkflowStatus(r.Status), URL: r.HTMLURL,
			ReportedConclusion: reportedConclusion(r.Status),
		}, r.ID, runName(r), r.Number)
		out = append(out, withRunFacts(stand, r.Status, r.StartedAt, r.StoppedAt))
	}

	return out
}

// branchJobState is the state a job counts in. A job whose needs failed is
// never started: Forgejo leaves it blocked in a run that has failed, so it is
// no wait and reads as cancelled, which the counts leave out as they do for a
// pull request (blockedInFailedRuns). A queued job of the failed run, or a
// blocked one in a run that can still go, stays a wait.
func branchJobState(r *branchRun, j *gitea.ActionWorkflowJob) dashboard.CheckState {
	if j.Status == "blocked" && checkStateFromWorkflowStatus(r.Status) == dashboard.CheckFailure {
		return dashboard.CheckCancelled
	}

	return checkStateFromWorkflowStatus(j.Status)
}

// runName names a run for the one check that stands in for its unreadable jobs:
// its workflow file without the ref and extension ("ci.yaml@refs/heads/main"
// is "ci"), else the run's title.
func runName(r *branchRun) string {
	workflow, _, _ := strings.Cut(r.WorkflowID, "@")
	workflow = strings.TrimSuffix(strings.TrimSuffix(workflow, ".yaml"), ".yml")
	if workflow != "" {
		return workflow
	}

	return r.Title
}

// jobExcerptKeys keys each listed job's log excerpt, by job id.
func jobExcerptKeys(repo dashboard.RepoRef, jobs map[int64][]*gitea.ActionWorkflowJob) map[int64]excerptKey {
	keys := map[int64]excerptKey{}
	for _, list := range jobs {
		for _, j := range list {
			keys[j.ID] = newExcerptKey(repo.Owner, repo.Name, j)
		}
	}

	return keys
}

// countChecks tallies checks into passed, running, waiting and failed. A
// cancelled check is in none of the four, as for a pull request: nothing
// broke, and mainBranchStatus reads it the same way.
func countChecks(checks []dashboard.Check) dashboard.CheckCounts {
	var out dashboard.CheckCounts
	for _, c := range checks {
		tally(&out, c.State)
	}

	return out
}

// tally counts one check in its state. Passed includes skipped, as on the wire.
func tally(out *dashboard.CheckCounts, state dashboard.CheckState) {
	switch state {
	case dashboard.CheckSuccess:
		out.Passed++
	case dashboard.CheckSkipped:
		out.Passed++
		out.Skipped++
	case dashboard.CheckRunning:
		out.Running++
	case dashboard.CheckQueued:
		out.Waiting++
	case dashboard.CheckFailure:
		out.Failed++
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
// when its jobs weren't read or none shows as failed.
func failingJobNames(runs []*branchRun, jobs map[int64][]*gitea.ActionWorkflowJob) []string {
	names := []string{}
	for _, run := range runs {
		var failing []string
		wanted := checkStateFromWorkflowStatus(run.Status)
		for _, j := range jobs[run.ID] {
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

	c = c.withContext(ctx)
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

// unset is a time Forgejo left blank: Go's zero time, or the Unix epoch it
// writes for a run that has not started. Either one would make a duration of
// decades.
func unset(t time.Time) bool {
	return t.IsZero() || t.Unix() <= 0
}

// runTimes is when the last run finished and how long the commit's pipeline
// took, from the first start to that finish. The finish is nil when no run has
// a real stop. The duration is nil when no run has a real start as well.
func runTimes(runs []*branchRun) (finished *time.Time, seconds *int) {
	var first, last time.Time
	for _, r := range runs {
		if !unset(r.StartedAt) && (first.IsZero() || r.StartedAt.Before(first)) {
			first = r.StartedAt
		}
		if !unset(r.StoppedAt) && r.StoppedAt.After(last) {
			last = r.StoppedAt
		}
	}
	if last.IsZero() {
		return nil, nil
	}
	if first.IsZero() {
		return &last, nil
	}
	d := max(int(last.Sub(first).Seconds()), 0)

	return &last, &d
}
