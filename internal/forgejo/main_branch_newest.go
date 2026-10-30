package forgejo

import (
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// newestBranchRuns is runs without the ones a newer run of the same workflow
// replaces (dashboard.SupersededRuns), in order. Forgejo's runs list names a
// run's workflow file and its number in the repo, and has no attempt: a rerun
// is the same run, so it never appears twice, and its attempt is read from the
// jobs. A run without a number is never replaced.
func newestBranchRuns(runs []*branchRun) []*branchRun {
	checks := make([]dashboard.Check, len(runs))
	for i, r := range runs {
		checks[i] = dashboard.Check{RunName: runName(r), RunNumber: r.Number}
		if checkStateFromWorkflowStatus(r.Status) == dashboard.CheckCancelled {
			checks[i].Run = &dashboard.RunFacts{Conclusion: dashboard.CheckConclusionCancelled}
		}
	}
	gone := dashboard.SupersededRuns(checks)

	out := make([]*branchRun, 0, len(runs))
	for i, r := range runs {
		if !gone[i] {
			out = append(out, r)
		}
	}

	return out
}
