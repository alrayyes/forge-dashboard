package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// jobOf is a job of workflow 1, started by a pull request.
func jobOf(workflow, name string, number, attempt int64, state dashboard.CheckState) dashboard.Check {
	return dashboard.Check{
		Name: name, RunName: workflow, RunNumber: number, RunAttempt: attempt, State: state,
		WorkflowID: 1, Event: "pull_request",
	}
}

func TestWithoutReplacedCancelled(t *testing.T) {
	t.Parallel()

	later := jobOf("pr-title", "check", 6, 1, dashboard.CheckSuccess)
	with := func(change func(*dashboard.Check)) []dashboard.Check {
		c := later
		change(&c)

		return []dashboard.Check{c}
	}
	state := func(s dashboard.CheckState) []dashboard.Check {
		return with(func(c *dashboard.Check) { c.State = s })
	}

	cancelled := jobOf("pr-title", "check", 5, 1, dashboard.CheckCancelled)
	for name, tc := range map[string]struct {
		other   []dashboard.Check
		dropped bool
	}{
		"a later run passed":                 {[]dashboard.Check{later}, true},
		"a later run failed":                 {state(dashboard.CheckFailure), true},
		"a later run timed out":              {state(dashboard.CheckTimedOut), true},
		"a later run is going":               {state(dashboard.CheckRunning), true},
		"a later run is queued":              {state(dashboard.CheckQueued), true},
		"a later attempt of the run":         {with(func(c *dashboard.Check) { c.RunNumber, c.RunAttempt = 5, 2 }), true},
		"no later run":                       {[]dashboard.Check{}, false},
		"an earlier run":                     {with(func(c *dashboard.Check) { c.RunNumber = 4 }), false},
		"a later run that was skipped":       {state(dashboard.CheckSkipped), false},
		"a later run that ended neutral":     {with(func(c *dashboard.Check) { c.ReportedConclusion = "neutral" }), false},
		"a later run that was cancelled":     {state(dashboard.CheckCancelled), false},
		"a later run nobody can grade":       {state(dashboard.CheckUnknown), false},
		"a later run held for approval":      {state(dashboard.CheckAwaitingApproval), false},
		"another workflow of the same name":  {with(func(c *dashboard.Check) { c.WorkflowID = 2 }), false},
		"a run another event started":        {with(func(c *dashboard.Check) { c.Event = "push" }), false},
		"another job of the workflow":        {with(func(c *dashboard.Check) { c.Name = "lint" }), false},
		"a check that names no workflow run": {[]dashboard.Check{{Name: "check", State: dashboard.CheckSuccess}}, false},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			checks := append([]dashboard.Check{cancelled}, tc.other...)
			want := checks
			if tc.dropped {
				want = tc.other
			}

			assert.Equal(t, want, dashboard.WithoutReplacedCancelled(checks))
		})
	}

	t.Run("runs of an unknown workflow replace nothing", func(t *testing.T) {
		t.Parallel()

		first, second := cancelled, later
		first.WorkflowID, second.WorkflowID = 0, 0

		assert.Len(t, dashboard.WithoutReplacedCancelled([]dashboard.Check{first, second}), 2)
	})
}
