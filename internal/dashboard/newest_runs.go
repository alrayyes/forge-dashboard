package dashboard

import "slices"

// WithoutReplacedCancelled is checks without the cancelled ones a later run
// replaced, in order. It is for the head of a pull request, and narrower than
// SupersededRuns: only a cancelled check is dropped, and only when its own job
// ran again. The later check has the same name, workflow and starting event, a
// higher run number or a later attempt, and passed, failed or is still going.
// A skipped or neutral one tested nothing, so it replaces nothing. A check
// whose workflow or run number is unknown is kept.
func WithoutReplacedCancelled(checks []Check) []Check {
	out := make([]Check, 0, len(checks))
	for _, c := range checks {
		replaced := c.State == CheckCancelled && c.WorkflowID != 0 && c.RunNumber != 0 &&
			slices.ContainsFunc(checks, func(later Check) bool {
				return canReplaceCancelled(later) && later.WorkflowID == c.WorkflowID &&
					later.Event == c.Event && later.Name == c.Name &&
					olderThan(c.RunNumber, c.RunAttempt, later.RunNumber, later.RunAttempt)
			})
		if !replaced {
			out = append(out, c)
		}
	}

	return out
}

// canReplaceCancelled reports whether a check says something about the code, or
// is on its way to: it passed, failed, or has not finished.
func canReplaceCancelled(c Check) bool {
	switch c.State {
	case CheckSuccess:
		// A neutral conclusion reads as a pass but tested nothing.
		return c.ReportedConclusion != "neutral"
	case CheckFailure, CheckTimedOut, CheckRunning, CheckQueued:
		return true
	default:
		return false
	}
}

// SupersededRuns marks, for each check, whether a newer run of its workflow
// replaces it: a run of the same workflow with a higher number, or a later
// attempt of the same run. The commit a default branch reads can carry many runs
// of one workflow (scheduled and dispatched ones beside the push), and only the
// newest says whether the code works now. A run that was only cancelled
// replaces nothing, as it says nothing about the code. A check with no workflow
// name or run number (another check app, a legacy status) is never superseded.
func SupersededRuns(checks []Check) []bool {
	type version struct{ number, attempt int64 }
	newest := map[string]version{}
	for _, c := range checks {
		if !canSupersede(c) {
			continue
		}
		v := version{c.RunNumber, c.RunAttempt}
		if cur, ok := newest[c.RunName]; !ok || olderThan(cur.number, cur.attempt, v.number, v.attempt) {
			newest[c.RunName] = v
		}
	}

	out := make([]bool, len(checks))
	for i, c := range checks {
		if c.RunName == "" || c.RunNumber == 0 {
			continue
		}
		cur, ok := newest[c.RunName]
		out[i] = ok && olderThan(c.RunNumber, c.RunAttempt, cur.number, cur.attempt)
	}

	return out
}

// olderThan reports whether run number a, attempt b came before number c,
// attempt d.
func olderThan(a, b, c, d int64) bool {
	return a < c || (a == c && b < d)
}

// canSupersede reports whether a check's run can replace an older run of its
// workflow.
func canSupersede(c Check) bool {
	if c.RunName == "" || c.RunNumber == 0 {
		return false
	}

	return c.Run == nil || c.Run.Conclusion != CheckConclusionCancelled
}

// NewestRuns is checks without the ones SupersededRuns marks, in order.
func NewestRuns(checks []Check) []Check {
	gone := SupersededRuns(checks)
	out := make([]Check, 0, len(checks))
	for i, c := range checks {
		if !gone[i] {
			out = append(out, c)
		}
	}

	return out
}
