package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func jobOf(workflow, name string, number, attempt int64, state dashboard.CheckState) dashboard.Check {
	return dashboard.Check{Name: name, RunName: workflow, RunNumber: number, RunAttempt: attempt, State: state}
}

func TestWithoutReplacedCancelled(t *testing.T) {
	t.Parallel()

	cancelled := jobOf("pr-title", "check", 5, 1, dashboard.CheckCancelled)
	for name, tc := range map[string]struct {
		other   []dashboard.Check
		dropped bool
	}{
		"a later run passed":                 {[]dashboard.Check{jobOf("pr-title", "check", 6, 1, dashboard.CheckSuccess)}, true},
		"a later run failed":                 {[]dashboard.Check{jobOf("pr-title", "check", 6, 1, dashboard.CheckFailure)}, true},
		"a later run is going":               {[]dashboard.Check{jobOf("pr-title", "check", 6, 1, dashboard.CheckRunning)}, true},
		"a later attempt of the run":         {[]dashboard.Check{jobOf("pr-title", "check", 5, 2, dashboard.CheckSuccess)}, true},
		"no later run":                       {[]dashboard.Check{}, false},
		"an earlier run":                     {[]dashboard.Check{jobOf("pr-title", "check", 4, 1, dashboard.CheckSuccess)}, false},
		"another workflow's job of the name": {[]dashboard.Check{jobOf("other", "check", 6, 1, dashboard.CheckSuccess)}, false},
		"another job of the workflow":        {[]dashboard.Check{jobOf("pr-title", "lint", 6, 1, dashboard.CheckSuccess)}, false},
		"a later run that was cancelled":     {[]dashboard.Check{jobOf("pr-title", "check", 6, 1, dashboard.CheckCancelled)}, false},
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
}
