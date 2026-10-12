package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A Forgejo delivery re-reads one repo's default branch (#1316), with the
// default branch and URL the last full poll learned.
func TestGenericSource_FetchMainBranch_ReadsOneRepoWithItsRef(t *testing.T) {
	t.Parallel()

	client := &branchClient{
		repos: []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a", URL: "https://forge/o/a", DefaultBranch: "main"}},
		answers: map[string]dashboard.MainBranch{
			"o/a": {Status: dashboard.MainBranchPassed, Branch: "main"},
		},
	}
	src := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)
	src.Fetch(t.Context())

	row, err := src.FetchMainBranch(t.Context(), "o", "a", "o/a")

	require.NoError(t, err)
	assert.Equal(t, dashboard.ForgeForgejo, row.Forge)
	assert.Equal(t, "o/a", row.FullName)
	assert.Equal(t, "https://forge/o/a", row.URL)
	assert.Equal(t, dashboard.MainBranchPassed, row.Status)
	assert.NotNil(t, row.FailingJobs, "the contract promises an array")
}

func TestGenericSource_FetchMainBranch_ARepoNoPollHasSeenIsAnError(t *testing.T) {
	t.Parallel()

	client := &branchClient{}
	src := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 2)

	_, err := src.FetchMainBranch(t.Context(), "o", "a", "o/a")

	require.Error(t, err)
}
