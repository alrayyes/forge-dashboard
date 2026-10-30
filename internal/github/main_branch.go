package github

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// checkRunFields is what the query reads of one check run, in the default
// branch's rollup and in the follow-up read of a newer run's checks.
const checkRunFields = `
                      databaseId
                      name
                      status
                      conclusion
                      startedAt
                      completedAt
                      detailsUrl
                      checkSuite {
                        status
                        conclusion
                        workflowRun {
                          databaseId
                          runAttempt
                          runNumber
                          workflow { name }
                        }
                      }`

// defaultBranchSelection is the part of a repository query that reads the CI
// of the default branch's newest commit (#1224). It rides the query every
// refresh already makes for a repo's pull requests, so it costs no request of
// its own, and a repo that is empty answers null. It reads the first 100 checks
// of the commit for their names and times, and the newest 50 check suites for
// the workflow run each belongs to. GitHub's rollup can lack the checks of a
// newer run (a scheduled or dispatched one) and keeps a failed older one in its
// state, so withNewestRuns reads the missing runs' checks and rebuilds the
// rollup from the newest run of each workflow (newest_runs.go).
//
// It also reads the repository's latestRelease, a single node that GitHub
// answers without drafts and pre-releases, so a row can link to it.
const defaultBranchSelection = `
        latestRelease {
          tagName
          url
        }
        defaultBranchRef {
          name
          target {
            ... on Commit {
              oid
              abbreviatedOid
              messageHeadline
              url
              committedDate
              author {
                name
                user {
                  login
                }
              }
              checkSuites(last: 50) {
                nodes {
                  id
                  status
                  conclusion
                  workflowRun {
                    databaseId
                    runAttempt
                    runNumber
                    workflow { name }
                  }
                }
              }
              statusCheckRollup {
                state
                contexts(first: 100) {
                  checkRunCountsByState { state count }
                  statusContextCountsByState { state count }
                  nodes {
                    __typename
                    ... on CheckRun {` + checkRunFields + `
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                    }
                  }
                }
              }
            }
          }
        }
`

// graphqlBranchRef is a repository's defaultBranchRef.
type graphqlBranchRef struct {
	Name   string        `json:"name"`
	Target graphqlCommit `json:"target"`
	// heldRunURL is the page of a workflow run held for approval on the newest
	// commit, set by withCheckedCommits (#2024). Not part of the response.
	heldRunURL string
}

// graphqlRelease is a repository's latestRelease.
type graphqlRelease struct {
	TagName string `json:"tagName"`
	URL     string `json:"url"`
}

// asRow is the release a row links to, nil for none or one with nothing to link.
func (r *graphqlRelease) asRow() *dashboard.MainBranchRelease {
	if r == nil || r.TagName == "" || r.URL == "" {
		return nil
	}

	return &dashboard.MainBranchRelease{Tag: r.TagName, URL: r.URL}
}

// graphqlCommit is a commit with the CI that ran on it.
type graphqlCommit struct {
	OID             string    `json:"oid"`
	AbbreviatedOID  string    `json:"abbreviatedOid"`
	MessageHeadline string    `json:"messageHeadline"`
	URL             string    `json:"url"`
	CommittedDate   time.Time `json:"committedDate"`
	Author          *struct {
		Name string `json:"name"`
		User *struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"author"`
	StatusCheckRollup *statusCheckRollup `json:"statusCheckRollup"`
	// CheckSuites are the newest suites of the commit, one per workflow run,
	// read so withNewestRuns can find a run the rollup leaves out.
	CheckSuites *struct {
		Nodes []branchSuite `json:"nodes"`
	} `json:"checkSuites"`
}

// branchContext is one check run or one legacy commit status.
type branchContext struct {
	Typename    string    `json:"__typename"`
	DatabaseID  int64     `json:"databaseId"`
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt"`
	DetailsURL  string    `json:"detailsUrl"`
	// CheckSuite is the suite a check run belongs to, whose workflow run is
	// null for a check app that isn't Actions.
	CheckSuite *struct {
		Status      string `json:"status"`
		Conclusion  string `json:"conclusion"`
		WorkflowRun *struct {
			DatabaseID int64 `json:"databaseId"`
			RunAttempt int64 `json:"runAttempt"`
			RunNumber  int64 `json:"runNumber"`
			Workflow   struct {
				Name string `json:"name"`
			} `json:"workflow"`
		} `json:"workflowRun"`
	} `json:"checkSuite"`
	Context   string `json:"context"`
	State     string `json:"state"`
	TargetURL string `json:"targetUrl"`
}

// mainBranchFrom maps a repo's defaultBranchRef onto its default-branch row.
// ref is nil for a repo with no commit yet.
func mainBranchFrom(fullName, repoURL string, release *graphqlRelease, ref *graphqlBranchRef) dashboard.MainBranch {
	row := dashboard.MainBranch{
		Forge: dashboard.ForgeGitHub, FullName: fullName, URL: repoURL,
		Status: dashboard.MainBranchNone, FailingJobs: []string{}, RunURL: repoURL,
		LatestRelease: release.asRow(),
	}
	if ref == nil {
		return row
	}
	row.Branch = ref.Name
	target := ref.Target
	if target.OID == "" {
		return row
	}

	row.Commit = &dashboard.MainBranchCommit{
		SHA:     dashboard.ShortSHA(target.OID),
		Subject: target.MessageHeadline,
	}
	if target.Author != nil {
		row.Commit.Author = target.Author.Name
		if target.Author.User != nil && target.Author.User.Login != "" {
			row.Commit.Author = target.Author.User.Login
		}
	}
	if !target.CommittedDate.IsZero() {
		at := target.CommittedDate
		row.Commit.CommittedAt = &at
	}
	row.RunURL = target.URL + "/checks"
	rollup := target.StatusCheckRollup
	if rollup == nil {
		markAwaitingApproval(&row, ref)

		return row
	}
	row.Status = dashboard.MainBranchStatusOfCI(rollup.ci())
	if rollup.Contexts == nil {
		return row
	}
	checks := rollup.Contexts.Nodes
	row.Runs = branchRuns(rollup)
	if row.Status == dashboard.MainBranchFailed {
		row.FailingJobs = failingBranchChecks(checks)
		if len(row.FailingJobs) == 0 && hasCancelledCheck(checks) {
			// GitHub rolls a cancelled run up as FAILURE; nothing broke (#1950).
			row.Status = dashboard.MainBranchCancelled
		}
	}
	row.Checks = branchCheckCounts(rollup, row.Status)
	if url := branchRunURL(checks, row.Status); url != "" {
		row.RunURL = url
	}
	if row.Status != dashboard.MainBranchRunning {
		row.FinishedAt, row.DurationSeconds = branchTimes(checks)
	}

	return row
}

// branchRuns is the checks the query read, grouped by the workflow run each
// belongs to, for a page to fold itself. The rollup counts every check of the
// commit but the query reads only the first 100, so when the counts add up to
// more, every run says its list is cut short.
func branchRuns(rollup *statusCheckRollup) []dashboard.MainBranchRun {
	nodes := rollup.Contexts.Nodes
	checks := make([]dashboard.Check, 0, len(nodes))
	for _, n := range nodes {
		checks = append(checks, n.asCheck())
	}
	runs := dashboard.MainBranchRuns(checks)

	cut := rollup.jobsCut || rollup.cutShort()
	for i := range runs {
		runs[i].JobsTruncated = cut
	}

	return runs
}

// asCheck is the check a node stands for: a job of a workflow run, a check of
// another app, or a legacy commit status.
func (c branchContext) asCheck() dashboard.Check {
	if c.Typename == "StatusContext" {
		return dashboard.Check{Name: c.Context, State: checkStateFromCombinedState(strings.ToLower(c.State)), URL: c.TargetURL}
	}

	check := dashboard.Check{
		Name:               c.Name,
		State:              checkStateOf(strings.ToLower(c.Status), strings.ToLower(c.Conclusion)),
		ReportedConclusion: reportedWord(c.Status, c.Conclusion),
		URL:                c.DetailsURL,
		JobID:              c.DatabaseID,
		StartedAt:          timePtr(c.StartedAt),
		CompletedAt:        timePtr(c.CompletedAt),
	}
	if c.CheckSuite == nil || c.CheckSuite.WorkflowRun == nil || c.CheckSuite.WorkflowRun.DatabaseID == 0 {
		return check
	}

	run := c.CheckSuite.WorkflowRun
	check.RunID, check.RunAttempt = run.DatabaseID, run.RunAttempt
	check.RunNumber, check.RunName = run.RunNumber, run.Workflow.Name
	suite := c.CheckSuite
	facts := &dashboard.RunFacts{}
	facts.Status, facts.Conclusion = dashboard.StatusFacts(
		checkStateOf(strings.ToLower(suite.Status), strings.ToLower(suite.Conclusion)),
		reportedWord(suite.Status, suite.Conclusion),
	)
	check.Run = facts

	return check
}

// reportedWord is the conclusion GraphQL gave a finished check or suite, in the
// lower case the REST API and the stream use, or "" while it is still going.
func reportedWord(status, conclusion string) string {
	if status != "COMPLETED" {
		return ""
	}

	return strings.ToLower(conclusion)
}

// timePtr is t, or nil when GitHub gave none.
func timePtr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}

	return &t
}

// branchCheckCounts is the rollup's counts for a branch in its final status. A
// cancelled branch has nothing failed, like a cancelled run anywhere. A failed
// branch with nothing counted as failed has a held run, which it reads as a
// failure and names as the failing job, or else cancelled runs with nothing
// running to replace them; a pull request says a held run with its own flag.
func branchCheckCounts(rollup *statusCheckRollup, status dashboard.MainBranchStatus) dashboard.CheckCounts {
	counts := rollup.rawCheckCounts()
	if status != dashboard.MainBranchFailed || counts.Failed > 0 {
		return counts
	}
	counts.Failed = rollup.runsInState("ACTION_REQUIRED")
	if counts.Failed == 0 {
		counts.Failed = rollup.runsInState("CANCELLED")
	}

	return counts
}

// markAwaitingApproval gives the row the awaiting-approval status when the
// newest commit's runs are held: they made no check run, so there is no rollup
// to read. The run's own page carries GitHub's approve button (#2024).
func markAwaitingApproval(row *dashboard.MainBranch, ref *graphqlBranchRef) {
	if ref.heldRunURL == "" {
		return
	}
	row.Status = dashboard.MainBranchAwaitingApproval
	row.RunURL = ref.heldRunURL
}

// failedConclusion reports a check run conclusion that breaks the branch, the
// same set settleFailedRollup counts as a failure.
func failedConclusion(conclusion string) bool {
	switch conclusion {
	case "FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE":
		return true
	default:
		return false
	}
}

// failingBranchChecks names the checks that broke the branch. Cancelled runs
// aren't among them: nothing broke (#1950).
func failingBranchChecks(checks []branchContext) []string {
	names := []string{}
	for _, c := range checks {
		switch {
		case c.Typename == "CheckRun" && failedConclusion(c.Conclusion):
			names = append(names, c.Name)
		case c.Typename == "StatusContext" && (c.State == "FAILURE" || c.State == "ERROR"):
			names = append(names, c.Context)
		}
	}

	return names
}

// hasCancelledCheck reports a check run that was cancelled.
func hasCancelledCheck(checks []branchContext) bool {
	return slices.ContainsFunc(checks, isCancelledCheck)
}

// isCancelledCheck reports a check run that was cancelled.
func isCancelledCheck(c branchContext) bool {
	return c.Typename == "CheckRun" && c.Conclusion == "CANCELLED"
}

// branchRunURL is where to look at the run: the first failed check for a failed
// branch, the first cancelled one for a cancelled branch, else the first check
// that has a page. Empty when no check does.
func branchRunURL(checks []branchContext, status dashboard.MainBranchStatus) string {
	var wanted func(branchContext) bool
	switch status {
	case dashboard.MainBranchFailed:
		wanted = func(c branchContext) bool {
			return slices.Contains(failingBranchChecks([]branchContext{c}), c.label())
		}
	case dashboard.MainBranchCancelled:
		wanted = isCancelledCheck
	}
	if wanted != nil {
		if url := firstPage(checks, wanted); url != "" {
			return url
		}
	}

	return firstPage(checks, func(branchContext) bool { return true })
}

// firstPage is the page of the first check that passes keep and has one.
func firstPage(checks []branchContext, keep func(branchContext) bool) string {
	for _, c := range checks {
		page := c.DetailsURL
		if c.Typename == "StatusContext" {
			page = c.TargetURL
		}
		if keep(c) && page != "" {
			return page
		}
	}

	return ""
}

// label is the name a check goes by.
func (c branchContext) label() string {
	if c.Typename == "StatusContext" {
		return c.Context
	}

	return c.Name
}

// runKey is the run attempt a check belongs to; the zero key for a check of no
// run.
func (c branchContext) runKey() runKey {
	if c.CheckSuite == nil || c.CheckSuite.WorkflowRun == nil {
		return runKey{}
	}

	return runKey{c.CheckSuite.WorkflowRun.DatabaseID, c.CheckSuite.WorkflowRun.RunAttempt}
}

type runKey struct{ id, attempt int64 }

// branchTimes is when the last check finished and how long the run that
// finished last took, from its own first start to that finish. A default
// branch's workflows run on their own schedules (a push, then a nightly one), so
// the span across all of them would count the days between two runs. Checks of
// no run share one group. Nil for either when no check ran with times, which a
// legacy commit status never has.
func branchTimes(checks []branchContext) (finished *time.Time, seconds *int) {
	type span struct{ first, last time.Time }
	spans := map[runKey]*span{}
	var newest *span
	for _, c := range checks {
		if c.Typename != "CheckRun" || c.StartedAt.IsZero() || c.CompletedAt.IsZero() {
			continue
		}
		run := c.runKey()
		sp, ok := spans[run]
		if !ok {
			sp = &span{first: c.StartedAt}
			spans[run] = sp
		}
		if c.StartedAt.Before(sp.first) {
			sp.first = c.StartedAt
		}
		if c.CompletedAt.After(sp.last) {
			sp.last = c.CompletedAt
		}
		if newest == nil || sp.last.After(newest.last) {
			newest = sp
		}
	}
	if newest == nil {
		return nil, nil
	}
	d := max(int(newest.last.Sub(newest.first).Seconds()), 0)

	return &newest.last, &d
}

// checkedCommitsQuery builds one query that reads, for each repo, its newest
// commits with the CI that ran on them. Used only for a repo whose newest
// commit has no checks at all (#1265): a release bot's "[skip ci]" commit
// leaves the branch with no rollup, though the commit before it has one.
func checkedCommitsQuery(repos []branchRepo) (string, map[string]any) {
	var q strings.Builder
	vars := make(map[string]any, len(repos)*2)
	q.WriteString("query(")
	for i, r := range repos {
		fmt.Fprintf(&q, "$owner%d: String!, $name%d: String!, ", i, i)
		vars[fmt.Sprintf("owner%d", i)] = r.owner
		vars[fmt.Sprintf("name%d", i)] = r.name
	}
	q.WriteString(") {\n  rateLimit { cost }\n")
	for i := range repos {
		fmt.Fprintf(&q, `  m%[1]d: repository(owner: $owner%[1]d, name: $name%[1]d) {
    defaultBranchRef { target { ... on Commit { history(first: 10) { nodes {
      oid abbreviatedOid messageHeadline url committedDate
      author { name user { login } }
      statusCheckRollup {
        state
        contexts(first: 50) {
          checkRunCountsByState { state count }
          statusContextCountsByState { state count }
          nodes {
            __typename
            ... on CheckRun { name conclusion startedAt completedAt detailsUrl }
            ... on StatusContext { context state targetUrl }
          }
        }
      }
    } } } } }
  }
`, i)
	}
	q.WriteString("}")

	return q.String(), vars
}

// branchRepo names a repo whose default branch may need a deeper look.
type branchRepo struct {
	owner, name string
	ref         *graphqlBranchRef
}

// heldBranchRun reports whether the commit's workflow runs are held for
// approval, and the page of the newest held run. It answers from the per-commit
// answer the pull request pill and the panel share when there is one, whether
// held, not held or unreadable, so a poll every few seconds costs a request a
// minute for a commit, and a token that cannot read Actions is not asked again
// on every poll (the forge API budget). Unreadable reads as not held.
func (c *Client) heldBranchRun(ctx context.Context, owner, name, sha string) (string, bool) {
	if answer, ok := c.requiredChecks.cachedHeld(sha); ok {
		return answer.runURL, answer.held
	}
	held := c.heldWorkflowChecks(ctx, owner, name, sha)
	if len(held) == 0 {
		return "", false
	}

	return held[0].URL, true
}

// uncheckedBranches picks the repos whose newest commit has no rollup and are
// worth walking back for. A commit whose runs are held for approval has no check
// run for the same reason a [skip ci] one has none, but it is not finished: its
// ref is marked and left where it is, so the row says so rather than showing an
// older commit's result (#2024).
func (c *Client) uncheckedBranches(ctx context.Context, tracked []graphqlRepo) []branchRepo {
	var unchecked []branchRepo
	for _, r := range tracked {
		ref := r.DefaultBranchRef
		if ref == nil || ref.Target.OID == "" || ref.Target.StatusCheckRollup != nil {
			continue
		}
		if runURL, held := c.heldBranchRun(ctx, r.Owner.Login, r.Name, ref.Target.OID); held {
			ref.heldRunURL = runURL
			if ref.heldRunURL == "" {
				ref.heldRunURL = ref.Target.URL + "/checks"
			}

			continue
		}
		unchecked = append(unchecked, branchRepo{owner: r.Owner.Login, name: r.Name, ref: ref})
	}

	return unchecked
}

// withCheckedCommits moves each ref's target to the newest commit a check ran
// on, for the repos whose newest commit has none and no runs held for approval. Any failure leaves the refs
// as they were, so the row reads none rather than the poll failing.
func (c *Client) withCheckedCommits(ctx context.Context, tracked []graphqlRepo) {
	unchecked := c.uncheckedBranches(ctx, tracked)
	if len(unchecked) == 0 {
		return
	}
	query, vars := checkedCommitsQuery(unchecked)
	var resp map[string]struct {
		DefaultBranchRef *struct {
			Target struct {
				History struct {
					Nodes []graphqlCommit `json:"nodes"`
				} `json:"history"`
			} `json:"target"`
		} `json:"defaultBranchRef"`
	}
	if err := c.graphqlDo(ctx, query, vars, &resp); err != nil {
		slog.Warn("github checked-commit lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

		return
	}
	for i, r := range unchecked {
		repo, ok := resp[fmt.Sprintf("m%d", i)]
		if !ok || repo.DefaultBranchRef == nil {
			continue
		}
		for _, commit := range repo.DefaultBranchRef.Target.History.Nodes {
			if commit.StatusCheckRollup != nil {
				r.ref.Target = commit

				break
			}
		}
	}
}

// mainBranchQuery reads one repository's default branch, the same selection
// the account-wide query makes for every tracked repo.
var mainBranchQuery = `query($owner: String!, $name: String!) {
  rateLimit { cost }
  repository(owner: $owner, name: $name) {
    url` + defaultBranchSelection + `  }
}`

// FetchMainBranch implements dashboard.MainBranchRefresher (#1316): the
// default-branch row of one repo, for a webhook delivery that finished a check.
// Without it the row only moved on the full poll, so a rerun that passed still
// read as failed.
func (c *Client) FetchMainBranch(ctx context.Context, owner, name, fullName string) (dashboard.MainBranch, error) {
	var resp struct {
		Repository *struct {
			URL              string            `json:"url"`
			LatestRelease    *graphqlRelease   `json:"latestRelease"`
			DefaultBranchRef *graphqlBranchRef `json:"defaultBranchRef"`
		} `json:"repository"`
	}
	if err := c.graphqlDo(ctx, mainBranchQuery, map[string]any{"owner": owner, "name": name}, &resp); err != nil {
		return dashboard.MainBranch{}, err
	}
	if resp.Repository == nil {
		return dashboard.MainBranch{}, fmt.Errorf("github: graphql: repository %s not found: %w", fullName, errRepositoryNotFound)
	}

	repo := graphqlRepo{Name: name, DefaultBranchRef: resp.Repository.DefaultBranchRef}
	repo.Owner.Login = owner
	c.withCheckedCommits(ctx, []graphqlRepo{repo})
	c.withNewestRuns(ctx, []graphqlRepo{repo})

	row := mainBranchFrom(fullName, resp.Repository.URL, resp.Repository.LatestRelease, repo.DefaultBranchRef)
	row.Advisories = c.advisoriesFor(ctx, owner, name, resp.Repository.URL)

	return row, nil
}
