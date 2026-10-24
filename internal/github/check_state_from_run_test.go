package github

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	ghsdk "github.com/google/go-github/v75/github"
	"github.com/stretchr/testify/assert"
)

// A run that has not started has no log to read, so every status the rollup
// counts as waiting reads as queued, not running.
func TestCheckStateFromRunNotStartedIsQueued(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"queued", "waiting", "pending", "requested"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			got := checkStateFromRun(&ghsdk.CheckRun{Status: new(status)})
			assert.Equal(t, dashboard.CheckQueued, got)
		})
	}
}

func TestCheckStateFromRunInProgressIsRunning(t *testing.T) {
	t.Parallel()
	got := checkStateFromRun(&ghsdk.CheckRun{Status: new("in_progress")})
	assert.Equal(t, dashboard.CheckRunning, got)
}

// Only in_progress has a log; a status GitHub adds later has not started
// either, so it reads queued rather than offering "View run" on nothing.
func TestCheckStateFromRunUnknownStatusIsQueued(t *testing.T) {
	t.Parallel()
	got := checkStateFromRun(&ghsdk.CheckRun{Status: new("brand_new_status")})
	assert.Equal(t, dashboard.CheckQueued, got)
}
