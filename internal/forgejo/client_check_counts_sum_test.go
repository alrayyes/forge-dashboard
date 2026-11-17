package forgejo_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

// The counts of a pull request add up to the jobs its pipeline lists, in every
// mix of the states a job can be in (#4064). Each mix is one run whose jobs are
// the chosen ones, served the way Forgejo does: a cancelled job is a failure
// status whose job says cancelled, a running one a pending status.
func TestListOpenPullRequests_CheckCountsAddUpToTheJobsListed(t *testing.T) {
	t.Parallel()

	kinds := []struct{ name, status, job string }{
		{"passed", "success", "success"},
		{"skipped", "skipped", "skipped"},
		{"failed", "failure", "failure"},
		{"cancelled", "failure", "cancelled"},
		{"running", "pending", "running"},
		{"queued", "pending", "queued"},
	}

	for mask := 1; mask < 1<<len(kinds); mask++ {
		var names []string
		f := forge{jobs: map[int][]string{12: {}}}
		runStatus := "success"
		failedRun := false
		for i, k := range kinds {
			if mask&(1<<i) == 0 {
				continue
			}
			names = append(names, k.name)
			position := len(f.jobs[12])
			f.statuses = append(f.statuses, jobStatus(k.status, fmt.Sprintf("ci / %s (pull_request)", k.name), 2, position))
			f.jobs[12] = append(f.jobs[12], k.job)
			if k.name == "failed" {
				failedRun = true
			}
			if k.status == "pending" && runStatus == "success" {
				runStatus = "running"
			}
		}
		// A run with a failed job has failed, whatever else is still queued in
		// it: Forgejo leaves the jobs that needed the failed one blocked there.
		if failedRun {
			runStatus = "failure"
		}
		f.runs = []map[string]any{actionsRun(12, 2, runStatus, nil)}
		total := len(f.statuses)

		t.Run(strings.Join(names, "+"), func(t *testing.T) {
			t.Parallel()

			c := f.pullRequest(t).Checks

			assert.Equal(t, total, c.Passed+c.Running+c.Waiting+c.Failed+c.Unknown+c.Cancelled+c.Held+c.NotStarted,
				"the counts add up to the jobs listed: %+v", c)
		})
	}
}
