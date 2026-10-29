package dashboard

import "fmt"

// RunGroup is the jobs of one run attempt, or one check that has no run.
type RunGroup struct {
	// Key names the unit: run/<id>/<attempt>, or job/<url>|<name> for a check
	// with no run.
	Key        string
	RunID      int64
	RunAttempt int64
	Checks     []Check
	// Run is what the forge said about the run attempt, taken from its first
	// job that carries it.
	Run *RunFacts
}

// GroupRuns splits a job list by run and attempt, in the order each first
// appears. A rerun keeps its run id and moves to a new attempt, so the pair is
// what tells one from the other. A check without a run is a group of its own,
// named by its address and name.
func GroupRuns(checks []Check) []RunGroup {
	var groups []RunGroup
	at := map[string]int{}
	for _, c := range checks {
		key := fmt.Sprintf("job/%s|%s", c.URL, c.Name)
		if c.RunID > 0 {
			key = fmt.Sprintf("run/%d/%d", c.RunID, c.RunAttempt)
		}
		i, ok := at[key]
		if !ok {
			i = len(groups)
			at[key] = i
			groups = append(groups, RunGroup{Key: key, RunID: c.RunID, RunAttempt: c.RunAttempt})
		}
		groups[i].Checks = append(groups[i].Checks, c)
		if groups[i].Run == nil && c.RunID > 0 {
			groups[i].Run = c.Run
		}
	}

	return groups
}
