package forgejo_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestListDefaultBranchChecks_CarriesTheStatusForgejoReportedAsTheConclusion(t *testing.T) {
	t.Parallel()

	run := actionRun(8, "main", "cafef00d", "failure", "2026-10-10T09:00:00Z", "2026-10-10T09:05:00Z")
	jobs := map[string][]map[string]any{"8": {
		{"id": 31, "name": "ok", "status": "success"},
		{"id": 32, "name": "bad", "status": "failure"},
		{"id": 33, "name": "stopped", "status": "cancelled"},
		{"id": 34, "name": "passed-over", "status": "skipped"},
		{"id": 35, "name": "going", "status": "running"},
		{"id": 36, "name": "held", "status": "blocked"},
	}}

	checks, err := branchChecksServer(t, []map[string]any{run}, jobs).ListDefaultBranchChecks(t.Context(), "alrayyes", "a")

	require.NoError(t, err)
	got := map[string]string{}
	for _, c := range checks {
		got[c.Name] = c.ReportedConclusion
	}
	assert.Equal(t, "success", got["ok"])
	assert.Equal(t, "failure", got["bad"])
	assert.Equal(t, "cancelled", got["stopped"])
	assert.Equal(t, "skipped", got["passed-over"])
	assert.Empty(t, got["going"])
	assert.Empty(t, got["held"], "blocked has not concluded")
}
