package github

import (
	"testing"

	ghsdk "github.com/google/go-github/v75/github"
	"github.com/stretchr/testify/assert"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// A run that has not started has no log to read, so every status the rollup
// counts as waiting reads as queued, not running.
func TestCheckStateFromRunNotStartedIsQueued(t *testing.T) {
	t.Parallel()
	for _, status := range []string{"queued", "waiting", "pending", "requested"} {
		t.Run(status, func(t *testing.T) {
			t.Parallel()
			got := checkStateFromRun(&ghsdk.CheckRun{Status: ghsdk.Ptr(status)})
			assert.Equal(t, dashboard.CheckQueued, got)
		})
	}
}

func TestCheckStateFromRunInProgressIsRunning(t *testing.T) {
	t.Parallel()
	got := checkStateFromRun(&ghsdk.CheckRun{Status: ghsdk.Ptr("in_progress")})
	assert.Equal(t, dashboard.CheckRunning, got)
}
