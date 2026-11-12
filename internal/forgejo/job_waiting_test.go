package forgejo

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A job nothing has started reads queued either way, but the reason differs:
// blocked waits on earlier jobs, waiting waits for a runner. The server sends
// that as a fact and the page words it. A blocked job in a run that has
// failed is never going to start, so it keeps today's reading with no reason.
func TestJobWaiting(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name      string
		jobStatus string
		runStatus string
		want      dashboard.WaitingFor
	}{
		{"blocked in a run that can still go", "blocked", "running", dashboard.WaitingForJobs},
		{"blocked in a waiting run", "blocked", "waiting", dashboard.WaitingForJobs},
		{"waiting for a runner", "waiting", "running", dashboard.WaitingForRunner},
		{"waiting in a failed run still gets a runner", "waiting", "failure", dashboard.WaitingForRunner},
		{"blocked in a failed run", "blocked", "failure", ""},
		{"unknown", "unknown", "running", ""},
		{"running", "running", "running", ""},
		{"skipped", "skipped", "running", ""},
		{"success", "success", "success", ""},
		{"unrecognized", "something-new", "running", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, jobWaiting(tc.jobStatus, tc.runStatus))
		})
	}
}
