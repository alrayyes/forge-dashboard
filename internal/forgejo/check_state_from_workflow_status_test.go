package forgejo

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// Forgejo's swagger lists eight statuses for a run, job or step: unknown,
// waiting, running, success, failure, cancelled, skipped and blocked. Three of
// them mean nothing has started: unknown (not yet set), waiting (for a runner)
// and blocked (on needs or concurrency). None has a log, so all read queued
// and a job in them offers no "View run".
func TestCheckStateFromWorkflowStatusNotStartedIsQueued(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"unknown", "waiting", "blocked", "something-new"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, dashboard.CheckQueued, checkStateFromWorkflowStatus(status))
		})
	}
}

func TestCheckStateFromWorkflowStatusRunningIsRunning(t *testing.T) {
	t.Parallel()
	assert.Equal(t, dashboard.CheckRunning, checkStateFromWorkflowStatus("running"))
}
