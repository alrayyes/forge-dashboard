package dashboard

import (
	"context"
	"slices"
	"strings"
	"time"
)

// MainBranchStatus is the result of the latest pipeline on a repo's default
// branch (#1224). Matches components.schemas.MainBranchStatus.
type MainBranchStatus string

// The four things a default branch's newest commit can be in. Failed wins over
// Running: a pipeline with one job down is broken however many others still run.
const (
	MainBranchFailed  MainBranchStatus = "failed"
	MainBranchPassed  MainBranchStatus = "passed"
	MainBranchRunning MainBranchStatus = "running"
	MainBranchNone    MainBranchStatus = "none"
)

// MainBranchStatusOfCI maps a combined CIStatus onto a default branch's status.
func MainBranchStatusOfCI(ci CIStatus) MainBranchStatus {
	switch ci {
	case CIFailure:
		return MainBranchFailed
	case CISuccess:
		return MainBranchPassed
	case CIPending:
		return MainBranchRunning
	default:
		return MainBranchNone
	}
}

// MainBranchCommit is the newest commit on a default branch. Matches
// components.schemas.MainBranchCommit.
type MainBranchCommit struct {
	// SHA is shortened to seven characters.
	SHA     string `json:"sha"`
	Subject string `json:"subject"`
	Author  string `json:"author"`
	// CommittedAt is nil when the forge didn't say.
	CommittedAt *time.Time `json:"committedAt"`
}

// ShortSHA cuts a commit id to the seven characters a person recognises.
func ShortSHA(sha string) string {
	const short = 7
	if len(sha) <= short {
		return sha
	}

	return sha[:short]
}

// MainBranch is one tracked repo and the CI status of its default branch.
// Matches components.schemas.MainBranch.
type MainBranch struct {
	Forge    Forge            `json:"forge"`
	FullName string           `json:"fullName"`
	URL      string           `json:"url"`
	Branch   string           `json:"branch"`
	Status   MainBranchStatus `json:"status"`
	// Commit is nil when the forge named no commit.
	Commit *MainBranchCommit `json:"commit"`
	// FailingJobs names the failed jobs, or the failed workflow when its jobs
	// couldn't be read. Never nil: the contract promises an array.
	FailingJobs []string `json:"failingJobs"`
	// FinishedAt and DurationSeconds are nil while the pipeline runs, and when
	// the forge didn't say.
	FinishedAt      *time.Time `json:"finishedAt"`
	DurationSeconds *int       `json:"durationSeconds"`
	// RunURL is where to see the run on the forge, falling back to URL.
	RunURL string `json:"runUrl"`
	// StaleSince is set on a row carried over from an earlier refresh because
	// its forge couldn't be read (#922): when it was last fetched. The API
	// derives the stale flag from it.
	StaleSince *time.Time `json:"staleSince"`
}

// MainBranchCounts is how many rows each status holds. Matches
// components.schemas.MainBranchCounts.
type MainBranchCounts struct {
	Failed  int `json:"failed"`
	Passed  int `json:"passed"`
	Running int `json:"running"`
	None    int `json:"none"`
	Total   int `json:"total"`
}

// CountMainBranches tallies rows by status.
func CountMainBranches(rows []MainBranch) MainBranchCounts {
	counts := MainBranchCounts{Total: len(rows)}
	for _, r := range rows {
		switch r.Status {
		case MainBranchFailed:
			counts.Failed++
		case MainBranchPassed:
			counts.Passed++
		case MainBranchRunning:
			counts.Running++
		default:
			counts.None++
		}
	}

	return counts
}

// SortMainBranches orders rows failed first, then running, passed and none,
// each group by repo name, so a broken main is the first thing on the page.
func SortMainBranches(rows []MainBranch) {
	rank := func(s MainBranchStatus) int {
		switch s {
		case MainBranchFailed:
			return 0
		case MainBranchRunning:
			return 1
		case MainBranchPassed:
			return 2
		default:
			return 3
		}
	}
	slices.SortStableFunc(rows, func(a, b MainBranch) int {
		if r := rank(a.Status) - rank(b.Status); r != 0 {
			return r
		}
		if c := strings.Compare(a.FullName, b.FullName); c != 0 {
			return c
		}

		return strings.Compare(string(a.Forge), string(b.Forge))
	})
}

// MainBranchReader is implemented by a ForgeClient that can read the CI
// status of a repo's default branch — checked via a type assertion, the same
// optional-capability pattern WebhookChecker uses. GitHub doesn't implement it:
// its answer rides the repository query the refresh already makes. The caller
// fills Forge, FullName and URL; the reader fills the rest.
type MainBranchReader interface {
	ReadMainBranch(ctx context.Context, repo RepoRef) (MainBranch, error)
}

// markMainBranchesStale returns rows with StaleSince set where it is not yet,
// to since, so a row carried over twice keeps the time it was really fetched.
func markMainBranchesStale(rows []MainBranch, since time.Time) []MainBranch {
	out := slices.Clone(rows)
	for i := range out {
		if out[i].StaleSince == nil {
			at := since
			out[i].StaleSince = &at
		}
	}

	return out
}
