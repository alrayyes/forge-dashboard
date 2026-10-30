package dashboard_test

import (
	"fmt"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func job(name, workflow string, number, attempt int64) dashboard.Check {
	return dashboard.Check{Name: name, RunID: number * 10, RunName: workflow, RunNumber: number, RunAttempt: attempt}
}

func labels(checks []dashboard.Check) []string {
	out := []string{}
	for _, c := range checks {
		out = append(out, fmt.Sprintf("%s@%s#%d.%d", c.Name, c.RunName, c.RunNumber, c.RunAttempt))
	}

	return out
}

func TestNewestRuns_ANewerRunOfTheSameWorkflowReplacesTheOlder(t *testing.T) {
	t.Parallel()

	checks := []dashboard.Check{
		job("reports", "ci", 1, 1),
		job("lint", "ci", 1, 1),
		job("reports", "ci", 2, 1),
		job("scan", "gitleaks", 1, 1),
	}

	got := dashboard.NewestRuns(checks)

	assert.Equal(t, []string{"reports@ci#2.1", "scan@gitleaks#1.1"}, labels(got),
		"run 1 of ci is replaced by run 2, a different workflow stands")
}

func TestNewestRuns_ALaterAttemptOfTheSameRunReplacesTheEarlier(t *testing.T) {
	t.Parallel()

	checks := []dashboard.Check{job("test", "ci", 1, 1), job("test", "ci", 1, 2)}

	assert.Equal(t, []string{"test@ci#1.2"}, labels(dashboard.NewestRuns(checks)))
}

func TestNewestRuns_ACancelledRunReplacesNothing(t *testing.T) {
	t.Parallel()

	cancelled := job("test", "ci", 2, 1)
	cancelled.Run = &dashboard.RunFacts{Status: dashboard.CheckStatusCompleted, Conclusion: dashboard.CheckConclusionCancelled}
	checks := []dashboard.Check{job("test", "ci", 1, 1), cancelled}

	assert.Len(t, dashboard.NewestRuns(checks), 2, "a run that was only cancelled says nothing about the code")
}

func TestNewestRuns_ChecksWithoutAWorkflowAreKept(t *testing.T) {
	t.Parallel()

	checks := []dashboard.Check{{Name: "codecov"}, {Name: "codecov"}, {Name: "x", RunID: 5}}

	assert.Len(t, dashboard.NewestRuns(checks), 3)
	assert.Equal(t, []bool{false, false, false}, dashboard.SupersededRuns(checks))
}
