package github

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The rollup counts a status it did not list, past its first 100 checks, so
// the counts rebuilt from the listed checks have none.
func TestKeepNewestRuns_KeepsThatTheCommitHasAStatus(t *testing.T) {
	t.Parallel()

	var rollup statusCheckRollup
	require.NoError(t, json.Unmarshal([]byte(`{"state":"FAILURE","contexts":{
		"checkRunCountsByState":[],
		"statusContextCountsByState":[{"state":"FAILURE","count":1}],
		"nodes":[]}}`), &rollup))

	rollup.keepNewestRuns([]branchContext{
		{Typename: "CheckRun", DatabaseID: 1, Name: "build", Status: "COMPLETED", Conclusion: "SUCCESS"},
	}, false)

	require.Empty(t, rollup.Contexts.StatusContextCountsByState)
	assert.True(t, rollup.hasStatuses())
}
