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

// defaultBranchSelection is the part of a repository query that reads the CI
// of the default branch's newest commit (#1224). It rides the query every
// refresh already makes for a repo's pull requests, so it costs no request of
// its own, and a repo that is empty answers null. It reads the first 50 checks
// of the commit for their names and times; the rollup's own state and counts
// cover the rest, so a commit with more still gets the right status and only
// the list of failing names can come up short.
const defaultBranchSelection = `
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
              statusCheckRollup {
                state
                contexts(first: 50) {
                  checkRunCountsByState { state count }
                  statusContextCountsByState { state count }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      startedAt
                      completedAt
                      detailsUrl
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
}

// branchContext is one check run or one legacy commit status.
type branchContext struct {
	Typename    string    `json:"__typename"`
	Name        string    `json:"name"`
	Conclusion  string    `json:"conclusion"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt"`
	DetailsURL  string    `json:"detailsUrl"`
	Context     string    `json:"context"`
	State       string    `json:"state"`
	TargetURL   string    `json:"targetUrl"`
}

// mainBranchFrom maps a repo's defaultBranchRef onto its default-branch row.
// ref is nil for a repo with no commit yet.
func mainBranchFrom(fullName, repoURL string, ref *graphqlBranchRef) dashboard.MainBranch {
	row := dashboard.MainBranch{
		Forge: dashboard.ForgeGitHub, FullName: fullName, URL: repoURL,
		Status: dashboard.MainBranchNone, FailingJobs: []string{}, RunURL: repoURL,
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
		return row
	}
	row.Status = dashboard.MainBranchStatusOfCI(rollup.ci())
	if rollup.Contexts == nil {
		return row
	}
	checks := rollup.Contexts.Nodes
	if row.Status == dashboard.MainBranchFailed {
		row.FailingJobs = failingBranchChecks(checks)
	}
	if url := branchRunURL(checks, row.Status); url != "" {
		row.RunURL = url
	}
	if row.Status != dashboard.MainBranchRunning {
		row.FinishedAt, row.DurationSeconds = branchTimes(checks)
	}

	return row
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

// failingBranchChecks names the checks that broke the branch. A rollup that
// failed only because runs were cancelled has none that failed, so it names the
// cancelled ones rather than nothing.
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
	if len(names) > 0 {
		return names
	}
	for _, c := range checks {
		if c.Typename == "CheckRun" && c.Conclusion == "CANCELLED" {
			names = append(names, c.Name)
		}
	}

	return names
}

// branchRunURL is where to look at the run: the first failed check for a failed
// branch, else the first check that has a page. Empty when no check does.
func branchRunURL(checks []branchContext, status dashboard.MainBranchStatus) string {
	page := func(c branchContext) string {
		if c.Typename == "StatusContext" {
			return c.TargetURL
		}

		return c.DetailsURL
	}
	if status == dashboard.MainBranchFailed {
		for _, c := range checks {
			if slices.Contains(failingBranchChecks([]branchContext{c}), c.label()) && page(c) != "" {
				return page(c)
			}
		}
	}
	for _, c := range checks {
		if page(c) != "" {
			return page(c)
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

// branchTimes is when the last check finished and how long the pipeline ran,
// from its first start to that finish. Nil for either when no check ran with
// times, which a legacy commit status never has.
func branchTimes(checks []branchContext) (finished *time.Time, seconds *int) {
	var first, last time.Time
	for _, c := range checks {
		if c.Typename != "CheckRun" || c.StartedAt.IsZero() || c.CompletedAt.IsZero() {
			continue
		}
		if first.IsZero() || c.StartedAt.Before(first) {
			first = c.StartedAt
		}
		if c.CompletedAt.After(last) {
			last = c.CompletedAt
		}
	}
	if last.IsZero() {
		return nil, nil
	}
	d := max(int(last.Sub(first).Seconds()), 0)

	return &last, &d
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
	q.WriteString(") {\n")
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

// withCheckedCommits moves each ref's target to the newest commit a check ran
// on, for the repos whose newest commit has none. Any failure leaves the refs
// as they were, so the row reads none rather than the poll failing.
func (c *Client) withCheckedCommits(ctx context.Context, tracked []graphqlRepo) {
	var unchecked []branchRepo
	for _, r := range tracked {
		if ref := r.DefaultBranchRef; ref != nil && ref.Target.OID != "" && ref.Target.StatusCheckRollup == nil {
			unchecked = append(unchecked, branchRepo{owner: r.Owner.Login, name: r.Name, ref: ref})
		}
	}
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

	return mainBranchFrom(fullName, resp.Repository.URL, repo.DefaultBranchRef), nil
}
