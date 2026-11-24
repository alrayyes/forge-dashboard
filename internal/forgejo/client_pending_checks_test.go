package forgejo_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The roll-up can wait on a check no job shows: a status from an external CI,
// or a context the branch rule requires that nothing has reported. The server
// names it, so the row can say which one without a trip to the forge (#4442).

func passedJobForge() forge {
	return forge{
		statuses: []map[string]string{jobStatus("success", "ci / test (pull_request)", 1, 0)},
		runs:     []map[string]any{actionsRun(11, 1, "success", nil)},
		jobs:     map[int][]string{11: {"success"}},
		state:    "success",
	}
}

func TestListOpenPullRequests_APendingStatusNoJobStandsBehindIsNamed(t *testing.T) {
	t.Parallel()
	f := passedJobForge()
	f.statuses = append(f.statuses, map[string]string{"status": "pending", "context": "external/scan"})
	f.state = "pending"

	got := f.pullRequest(t)

	assert.Equal(t, []string{"external/scan"}, got.PendingChecks)
}

func TestListOpenPullRequests_AnActionsJobThatIsPendingIsNotNamed(t *testing.T) {
	t.Parallel()
	f := forge{
		statuses: []map[string]string{jobStatus("pending", "ci / lint (pull_request)", 2, 0)},
		runs:     []map[string]any{actionsRun(12, 2, "running", nil)},
		jobs:     map[int][]string{12: {"running"}},
		state:    "pending",
	}

	assert.Empty(t, f.pullRequest(t).PendingChecks, "the pipeline lists that job already")
}

func TestListOpenPullRequests_ARequiredContextNothingReportedIsPendingAndNamed(t *testing.T) {
	t.Parallel()
	f := passedJobForge()
	f.required = []string{"ci / test (pull_request)", "deploy/gate"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CIPending, got.CI)
	assert.Equal(t, 1, got.Checks.Waiting)
	assert.Equal(t, []string{"deploy/gate"}, got.PendingChecks)
}

func TestListOpenPullRequests_ARequiredPatternAStatusMatchesIsNotMissing(t *testing.T) {
	t.Parallel()
	f := passedJobForge()
	f.required = []string{"ci / *"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CISuccess, got.CI)
	assert.Empty(t, got.PendingChecks)
}

func TestListOpenPullRequests_WithNoReadableRuleARowIsNotGuessedPending(t *testing.T) {
	t.Parallel()

	got := passedJobForge().pullRequest(t)

	assert.Equal(t, dashboard.CISuccess, got.CI)
	assert.Empty(t, got.PendingChecks)
}

func TestListOpenPullRequests_AFailureIsNotReadPendingForAMissingRequiredContext(t *testing.T) {
	t.Parallel()
	f := passedJobForge()
	f.statuses = append(f.statuses, map[string]string{"status": "failure", "context": "external/scan"})
	f.state = "failure"
	f.required = []string{"deploy/gate"}

	got := f.pullRequest(t)

	assert.Equal(t, dashboard.CIFailure, got.CI)
	assert.Empty(t, got.PendingChecks)
}

func TestListChecks_ListsARequiredContextNothingReportedAsQueued(t *testing.T) {
	t.Parallel()
	f := passedJobForge()
	f.required = []string{"deploy/gate"}

	checks, err := f.serve(t).client.ListChecks(t.Context(), "alrayyes", "a", 12)

	require.NoError(t, err)
	got := map[string]dashboard.CheckState{}
	for _, c := range checks {
		got[c.Name] = c.State
	}
	assert.Equal(t, dashboard.CheckQueued, got["deploy/gate"])
}
