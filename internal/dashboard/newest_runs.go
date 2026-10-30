package dashboard

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
