package forgejo

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// mainBranchStatus folds the runs themselves, before any job is read: a run
// still going outranks one nobody can grade, and one alone reads unknown
// whatever its jobs say (#4063).
func TestMainBranchStatus_UnknownRuns(t *testing.T) {
	t.Parallel()

	of := func(statuses ...string) []*branchRun {
		runs := make([]*branchRun, 0, len(statuses))
		for _, s := range statuses {
			runs = append(runs, &branchRun{Status: s})
		}

		return runs
	}

	cases := map[string]struct {
		runs []*branchRun
		want dashboard.MainBranchStatus
	}{
		"a run nobody can grade alone":            {of("brand-new"), dashboard.MainBranchUnknown},
		"one beside a success":                    {of("success", "brand-new"), dashboard.MainBranchUnknown},
		"one beside a cancelled run":              {of("cancelled", "brand-new"), dashboard.MainBranchUnknown},
		"a run still going outranks it":           {of("brand-new", "running"), dashboard.MainBranchRunning},
		"a queued run outranks it":                {of("brand-new", "waiting"), dashboard.MainBranchRunning},
		"a failure outranks it":                   {of("brand-new", "failure"), dashboard.MainBranchFailed},
		"cancelled beside a success is cancelled": {of("cancelled", "success"), dashboard.MainBranchCancelled},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, mainBranchStatus(tc.runs))
		})
	}
}
