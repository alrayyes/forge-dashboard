package forgejo

import (
	"testing"

	gitea "code.gitea.io/sdk/gitea"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// Forgejo's swagger lists eight statuses for a run, job or step: unknown,
// waiting, running, success, failure, cancelled, skipped and blocked. Three of
// them mean nothing has started: unknown (not yet set), waiting (for a runner)
// and blocked (on needs or concurrency). None has a log, so all read queued
// and a job in them offers no "Show output".
func TestCheckStateFromWorkflowStatusNotStartedIsQueued(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"unknown", "waiting", "blocked"} {
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

// A status Forgejo adds later is one nobody can grade: it is not a wait, so it
// reads unknown instead of queued.
func TestCheckStateFromWorkflowStatusUnrecognizedIsUnknown(t *testing.T) {
	t.Parallel()
	assert.Equal(t, dashboard.CheckUnknown, checkStateFromWorkflowStatus("something-new"))
}

// A commit status Forgejo adds later is counted on its own, not as a wait.
func TestCheckCountsOfUnrecognizedStatusIsUnknown(t *testing.T) {
	t.Parallel()
	got := checkCountsOf([]*gitea.Status{{State: "success"}, {State: "pending"}, {State: "something-new"}})
	assert.Equal(t, dashboard.CheckCounts{Passed: 1, Waiting: 1, Unknown: 1}, got)
}
