package dashboard_test

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// wireOf runs a check through WithFacts and reads back the keys it sends.
func wireOf(t *testing.T, state dashboard.CheckState) map[string]any {
	t.Helper()

	checks := dashboard.WithFacts([]dashboard.Check{{Name: "build", State: state, URL: "https://x/1"}})
	raw, err := json.Marshal(checks[0])
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(raw, &got))

	return got
}

func TestWithFacts_SendsStatusAndConclusionNotState(t *testing.T) {
	t.Parallel()

	cases := []struct {
		state      dashboard.CheckState
		status     string
		conclusion any
	}{
		{dashboard.CheckQueued, "queued", nil},
		{dashboard.CheckRunning, "in_progress", nil},
		{dashboard.CheckAwaitingApproval, "waiting", nil},
		{dashboard.CheckSuccess, "completed", "success"},
		{dashboard.CheckFailure, "completed", "failure"},
		{dashboard.CheckCancelled, "completed", "cancelled"},
		{dashboard.CheckSkipped, "completed", "skipped"},
		{dashboard.CheckTimedOut, "completed", "timed_out"},
	}
	for _, c := range cases {
		t.Run(string(c.state), func(t *testing.T) {
			t.Parallel()

			got := wireOf(t, c.state)

			assert.NotContains(t, got, "state")
			assert.Equal(t, c.status, got["status"])
			assert.Equal(t, c.conclusion, got["conclusion"])
		})
	}
}

func TestWithFacts_EveryStateMapsToAnEnumValueTheSpecAllows(t *testing.T) {
	t.Parallel()

	statuses := []dashboard.CheckStatus{
		dashboard.CheckStatusQueued, dashboard.CheckStatusInProgress,
		dashboard.CheckStatusCompleted, dashboard.CheckStatusWaiting,
	}
	conclusions := []dashboard.CheckConclusion{
		"", dashboard.CheckConclusionSuccess, dashboard.CheckConclusionFailure,
		dashboard.CheckConclusionCancelled, dashboard.CheckConclusionSkipped,
		dashboard.CheckConclusionTimedOut,
	}
	states := []dashboard.CheckState{
		dashboard.CheckQueued, dashboard.CheckRunning, dashboard.CheckSuccess,
		dashboard.CheckFailure, dashboard.CheckCancelled, dashboard.CheckSkipped,
		dashboard.CheckTimedOut, dashboard.CheckAwaitingApproval,
	}

	for _, s := range states {
		t.Run(string(s), func(t *testing.T) {
			t.Parallel()

			got := dashboard.WithFacts([]dashboard.Check{{State: s}})[0]

			assert.Contains(t, statuses, got.Status)
			assert.Contains(t, conclusions, got.Conclusion)
		})
	}
}

func TestWithFacts_KeepsTheOtherFieldsAndTheStateInProcess(t *testing.T) {
	t.Parallel()

	out := dashboard.WithFacts([]dashboard.Check{{
		Name: "build", State: dashboard.CheckRunning, URL: "https://x/1",
		JobID: 3, RunID: 7, RunName: "ci", RunNumber: 9, RunAttempt: 2,
	}})

	assert.Equal(t, dashboard.CheckRunning, out[0].State)
	assert.Equal(t, int64(7), out[0].RunID)
	assert.Equal(t, int64(2), out[0].RunAttempt)
}

func TestWithFacts_LeavesTheSourcesListAlone(t *testing.T) {
	t.Parallel()

	in := []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess}}

	dashboard.WithFacts(in)

	assert.Empty(t, in[0].Status)
}

func TestWithFacts_KeepsANilListNil(t *testing.T) {
	t.Parallel()

	assert.Nil(t, dashboard.WithFacts(nil))
}
