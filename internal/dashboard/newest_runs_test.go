package dashboard_test

import (
	"encoding/json"
	"fmt"
	"os"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fixtureCheck is one check of a case in testdata/newest_runs.json. The page's
// tests read the same file (web/src/lib/check-fold-newest.test.ts), so the two
// sides of the rule cannot drift apart.
type fixtureCheck struct {
	Name          string `json:"name"`
	RunName       string `json:"runName"`
	RunNumber     int64  `json:"runNumber"`
	RunAttempt    int64  `json:"runAttempt"`
	RunID         int64  `json:"runId"`
	RunConclusion string `json:"runConclusion"`
}

type fixtureCase struct {
	Name   string         `json:"name"`
	Checks []fixtureCheck `json:"checks"`
	Keep   []string       `json:"keep"`
}

func (f fixtureCheck) check() dashboard.Check {
	c := dashboard.Check{Name: f.Name, RunID: f.RunID, RunName: f.RunName, RunNumber: f.RunNumber, RunAttempt: f.RunAttempt}
	if f.RunConclusion != "" {
		c.Run = &dashboard.RunFacts{
			Status:     dashboard.CheckStatusCompleted,
			Conclusion: dashboard.CheckConclusion(f.RunConclusion),
		}
	}

	return c
}

func labels(checks []dashboard.Check) []string {
	out := []string{}
	for _, c := range checks {
		out = append(out, fmt.Sprintf("%s@%s#%d.%d", c.Name, c.RunName, c.RunNumber, c.RunAttempt))
	}

	return out
}

func TestNewestRuns_KeepsWhatTheSharedFixtureSays(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("testdata/newest_runs.json")
	require.NoError(t, err)
	var cases []fixtureCase
	require.NoError(t, json.Unmarshal(raw, &cases))
	require.NotEmpty(t, cases)

	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			t.Parallel()

			checks := make([]dashboard.Check, 0, len(tc.Checks))
			for _, f := range tc.Checks {
				checks = append(checks, f.check())
			}

			assert.Equal(t, tc.Keep, labels(dashboard.NewestRuns(checks)))
		})
	}
}

func TestNewestRuns_ChecksWithoutAWorkflowAreNeverSuperseded(t *testing.T) {
	t.Parallel()

	checks := []dashboard.Check{{Name: "codecov"}, {Name: "codecov"}, {Name: "x", RunID: 5}}

	assert.Equal(t, []bool{false, false, false}, dashboard.SupersededRuns(checks))
}
