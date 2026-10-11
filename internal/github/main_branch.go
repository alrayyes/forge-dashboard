package github

import (
	"slices"
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
	Name   string `json:"name"`
	Target struct {
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
	} `json:"target"`
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
