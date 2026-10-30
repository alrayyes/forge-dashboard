package github

import (
	"context"
	"log/slog"
	"slices"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// branchSuite is one check suite of the default branch's commit: for Actions,
// the checks of one workflow run.
type branchSuite struct {
	ID          string `json:"id"`
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
}

// asCheck is the suite as a check carrying only the identity of its run, enough
// for dashboard.SupersededRuns to order it against the others.
func (s branchSuite) asCheck() dashboard.Check {
	if s.WorkflowRun == nil {
		return dashboard.Check{}
	}
	run := s.WorkflowRun
	check := dashboard.Check{
		RunID: run.DatabaseID, RunAttempt: run.RunAttempt,
		RunNumber: run.RunNumber, RunName: run.Workflow.Name,
	}
	if strings.EqualFold(s.Conclusion, "CANCELLED") {
		check.Run = &dashboard.RunFacts{Conclusion: dashboard.CheckConclusionCancelled}
	}

	return check
}

// newestRunsQuery reads the check runs of the given suites.
const newestRunsQuery = `query($ids: [ID!]!) {
  rateLimit { cost }
  nodes(ids: $ids) {
    ... on CheckSuite {
      id
      checkRuns(first: 100) {
        nodes {
          __typename
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
          }
        }
      }
    }
  }
}`

// withNewestRuns makes each ref's rollup describe only the newest run of every
// workflow. GitHub's rollup state stays FAILURE while any run's check failed, and
// its checks can leave out a scheduled or dispatched run altogether, so a fresh
// run that passed could not clear an older failure. For a commit with a newer
// run than the rollup holds, or a rollup that lists a workflow's older run, the
// checks of the newest runs are read and the rollup's state and counts are
// worked out from them. A rollup with one run per workflow is left as GitHub
// gave it. A failed read leaves the rollup as it was.
//
// Only Actions checks are replaced: those of other check apps and legacy
// statuses past the first 100 of a commit are not read, so the row can miss
// them.
func (c *Client) withNewestRuns(ctx context.Context, tracked []graphqlRepo) {
	wanted := map[*graphqlRepo][]branchSuite{}
	var ids []string
	for i := range tracked {
		suites := suitesToRead(tracked[i].DefaultBranchRef)
		if len(suites) == 0 {
			continue
		}
		wanted[&tracked[i]] = suites
		for _, s := range suites {
			ids = append(ids, s.ID)
		}
	}

	read := map[string][]branchContext{}
	if len(ids) > 0 {
		read = c.readSuiteChecks(ctx, ids)
	}
	for i := range tracked {
		ref := tracked[i].DefaultBranchRef
		if ref == nil || ref.Target.StatusCheckRollup == nil || ref.Target.StatusCheckRollup.Contexts == nil {
			continue
		}
		var extra []branchContext
		for _, s := range wanted[&tracked[i]] {
			extra = append(extra, read[s.ID]...)
		}
		ref.Target.StatusCheckRollup.keepNewestRuns(extra)
	}
}

// suitesToRead is the newest suite of each workflow whose checks the rollup
// doesn't hold in full: the run is absent from it, or the rollup was cut short.
func suitesToRead(ref *graphqlBranchRef) []branchSuite {
	if ref == nil || ref.Target.CheckSuites == nil || ref.Target.StatusCheckRollup == nil || ref.Target.StatusCheckRollup.Contexts == nil {
		return nil
	}
	rollup := ref.Target.StatusCheckRollup
	suites := ref.Target.CheckSuites.Nodes
	checks := make([]dashboard.Check, len(suites))
	for i, s := range suites {
		checks[i] = s.asCheck()
	}
	superseded := dashboard.SupersededRuns(checks)

	cut := rollup.cutShort()
	held := map[int64]bool{}
	for _, n := range rollup.Contexts.Nodes {
		if n.CheckSuite != nil && n.CheckSuite.WorkflowRun != nil {
			held[n.CheckSuite.WorkflowRun.DatabaseID] = true
		}
	}

	var out []branchSuite
	for i, s := range suites {
		if s.WorkflowRun == nil || superseded[i] || checks[i].Run != nil || s.ID == "" {
			continue
		}
		if cut || !held[s.WorkflowRun.DatabaseID] {
			out = append(out, s)
		}
	}

	return out
}

// cutShort reports that the commit has more checks than the rollup listed.
func (r *statusCheckRollup) cutShort() bool {
	total := 0
	for _, c := range r.Contexts.CheckRunCountsByState {
		total += c.Count
	}
	for _, c := range r.Contexts.StatusContextCountsByState {
		total += c.Count
	}

	return total > len(r.Contexts.Nodes)
}

// readSuiteChecks is the check runs of each suite id, one request for all. A
// failed read is logged and answers none.
func (c *Client) readSuiteChecks(ctx context.Context, ids []string) map[string][]branchContext {
	var resp struct {
		Nodes []struct {
			ID        string `json:"id"`
			CheckRuns struct {
				Nodes []branchContext `json:"nodes"`
			} `json:"checkRuns"`
		} `json:"nodes"`
	}
	if err := c.graphqlDo(ctx, newestRunsQuery, map[string]any{"ids": ids}, &resp); err != nil {
		slog.Warn("github newest-run lookup failed", "forge", dashboard.ForgeGitHub, "error", err)

		return nil
	}

	out := make(map[string][]branchContext, len(resp.Nodes))
	for _, n := range resp.Nodes {
		out[n.ID] = n.CheckRuns.Nodes
	}

	return out
}

// keepNewestRuns adds extra (the checks of runs the rollup left out) to the
// rollup's checks, drops those a newer run of the same workflow replaces, and
// works the state and counts out from what is left. With nothing added or
// dropped it leaves the rollup as GitHub gave it.
func (r *statusCheckRollup) keepNewestRuns(extra []branchContext) {
	nodes := slices.Concat(r.Contexts.Nodes, extra)
	checks := make([]dashboard.Check, len(nodes))
	for i, n := range nodes {
		checks[i] = n.asCheck()
	}
	superseded := dashboard.SupersededRuns(checks)
	if len(extra) == 0 && !slices.Contains(superseded, true) {
		return
	}

	kept := make([]branchContext, 0, len(nodes))
	for i, n := range nodes {
		if !superseded[i] {
			kept = append(kept, n)
		}
	}

	runCounts, statusCounts := map[string]int{}, map[string]int{}
	failed, pending := false, false
	for _, n := range kept {
		if n.Typename == "StatusContext" {
			statusCounts[n.State]++
			failed = failed || n.State == "FAILURE" || n.State == "ERROR"
			pending = pending || n.State == "PENDING" || n.State == "EXPECTED"

			continue
		}
		if n.Status != "COMPLETED" {
			runCounts[n.Status]++
			pending = true

			continue
		}
		runCounts[n.Conclusion]++
		failed = failed || failedConclusion(n.Conclusion) || n.Conclusion == "CANCELLED"
	}

	r.Contexts.Nodes = kept
	r.Contexts.CheckRunCountsByState = countsOf(runCounts)
	r.Contexts.StatusContextCountsByState = countsOf(statusCounts)
	switch {
	case failed:
		r.State = "FAILURE"
	case pending:
		r.State = "PENDING"
	default:
		r.State = "SUCCESS"
	}
}

// countsOf is a tally as the rollup lists it, in a stable order.
func countsOf(tally map[string]int) []stateCount {
	out := make([]stateCount, 0, len(tally))
	for state, n := range tally {
		out = append(out, stateCount{State: state, Count: n})
	}
	slices.SortFunc(out, func(a, b stateCount) int { return strings.Compare(a.State, b.State) })

	return out
}
