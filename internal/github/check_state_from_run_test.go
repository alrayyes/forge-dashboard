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

// A status GitHub adds later is one nobody can grade: it is not a wait, so the
// check reads unknown rather than queued.
func TestCheckStateFromRunUnknownStatusIsUnknown(t *testing.T) {
	t.Parallel()
	got := checkStateFromRun(&ghsdk.CheckRun{Status: new("brand_new_status")})
	assert.Equal(t, dashboard.CheckUnknown, got)
}

// A conclusion the code does not list is unknown, not a failure: a conclusion
// GitHub adds later must not turn a pill red. stale and startup_failure are
// listed and stay failures.
func TestCheckStateOfConclusion(t *testing.T) {
	t.Parallel()
	cases := map[string]dashboard.CheckState{
		"success":         dashboard.CheckSuccess,
		"neutral":         dashboard.CheckSuccess,
		"skipped":         dashboard.CheckSkipped,
		"cancelled":       dashboard.CheckCancelled,
		"timed_out":       dashboard.CheckTimedOut,
		"action_required": dashboard.CheckAwaitingApproval,
		"failure":         dashboard.CheckFailure,
		"stale":           dashboard.CheckFailure,
		"startup_failure": dashboard.CheckFailure,
		"brand_new":       dashboard.CheckUnknown,
		"":                dashboard.CheckUnknown,
	}
	for conclusion, want := range cases {
		t.Run(conclusion, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, want, checkStateOf("completed", conclusion))
		})
	}
}

// The legacy commit status API says pending, success, failure or error; any
// other word is unknown, where it used to read as running.
func TestCheckStateFromCombinedState(t *testing.T) {
	t.Parallel()
	cases := map[string]dashboard.CheckState{
		"success": dashboard.CheckSuccess,
		"failure": dashboard.CheckFailure,
		"error":   dashboard.CheckFailure,
		"pending": dashboard.CheckRunning,
		"odd":     dashboard.CheckUnknown,
	}
	for state, want := range cases {
		t.Run(state, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, want, checkStateFromCombinedState(state))
		})
	}
}
