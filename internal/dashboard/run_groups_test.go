package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestGroupRuns_SplitsByRunAndAttempt(t *testing.T) {
	t.Parallel()

	started := time.Date(2026, 10, 29, 9, 0, 0, 0, time.UTC)
	facts := &dashboard.RunFacts{Status: dashboard.CheckStatusCompleted, Conclusion: "failure", StartedAt: &started}
	checks := []dashboard.Check{
		{Name: "lint", URL: "u/1", RunID: 7, RunAttempt: 1, Run: facts},
		{Name: "test", URL: "u/2", RunID: 7, RunAttempt: 1},
		{Name: "lint", URL: "u/1", RunID: 7, RunAttempt: 2},
		{Name: "legacy", URL: "https://ci.example/1"},
	}

	got := dashboard.GroupRuns(checks)

	assert.Len(t, got, 3, "a rerun is its own group, and a check with no run stands alone")
	assert.Equal(t, "run/7/1", got[0].Key)
	assert.Equal(t, int64(7), got[0].RunID)
	assert.Equal(t, int64(1), got[0].RunAttempt)
	assert.Len(t, got[0].Checks, 2)
	assert.Same(t, facts, got[0].Run, "the run's facts come from its first job that has them")
	assert.Equal(t, "run/7/2", got[1].Key)
	assert.Nil(t, got[1].Run)
	assert.Equal(t, "job/https://ci.example/1|legacy", got[2].Key)
	assert.Zero(t, got[2].RunID)
}
