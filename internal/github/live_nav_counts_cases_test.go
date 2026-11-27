package github_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The page's tests fold each case's jobs and expect the menu numbers the server
// gives the case (#5123). Those numbers are only right while a fetch reads the
// same jobs the way the case says.
func TestFetch_LiveNavCountCases(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("../../tests/generated/live-nav-counts.json")
	require.NoError(t, err)
	var file struct {
		Cases []struct {
			Name   string `json:"name"`
			Rollup string `json:"rollup"`
			Jobs   []struct {
				Status     string `json:"status"`
				Conclusion string `json:"conclusion"`
			} `json:"jobs"`
			CI                     dashboard.CIStatus `json:"ci"`
			FailingOnlyForApproval bool               `json:"failingOnlyForApproval"`
		} `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &file))
	require.NotEmpty(t, file.Cases)

	for _, c := range file.Cases {
		// A commit with no rollup has no jobs for the page to fold either.
		if c.Rollup == "" {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			t.Parallel()

			runs := map[string]int{}
			for _, job := range c.Jobs {
				state := job.Conclusion
				if state == "" {
					state = job.Status
				}
				runs[strings.ToUpper(state)]++
			}

			pr := pullRequestFromGraphQLRollup(t, rollupFixture(c.Rollup, runs, nil))

			assert.Equal(t, c.CI, pr.CI)
			assert.Equal(t, c.FailingOnlyForApproval, pr.FailingOnlyForApproval)
		})
	}
}
