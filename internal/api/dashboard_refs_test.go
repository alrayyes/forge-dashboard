package api_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDashboard_PullRequestsListTheTicketsTheyReference(t *testing.T) {
	t.Parallel()

	srvURL, cookie := mentionsServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "")

	t.Run("a ticket the pull request closes is not repeated as a ref", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, listOf(t, body, "pullRequests", "github:alrayyes/a#10", "refsIssues"))
	})
	t.Run("the refs are listed in order", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "github:alrayyes/a#12", "refsIssues")

		assert.Equal(t, []int{2, 99, 3}, numbers(got))
	})
	t.Run("each entry says it is a ref, where it opens and whether it is tracked", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "github:alrayyes/a#12", "refsIssues")

		first := got[0].(map[string]any)
		assert.Equal(t, "refs", first["relation"])
		assert.Equal(t, "/issues.html?issue=github/alrayyes/a/2", first["pageUrl"])
		assert.Equal(t, true, first["tracked"])
		assert.Equal(t, false, got[1].(map[string]any)["tracked"], "#99 is not an open issue")
	})
	t.Run("forgejo matches a lowercased repo against the mixed-case one", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "forgejo:Ryan/Hush#7", "refsIssues")[0].(map[string]any)

		assert.Equal(t, true, got["tracked"])
	})
	t.Run("a pull request that references nothing has an empty list", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, listOf(t, body, "pullRequests", "github:alrayyes/a#11", "refsIssues"))
	})
	t.Run("closing and mention entries name their relation too", func(t *testing.T) {
		t.Parallel()

		closes := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "closesIssues")[0].(map[string]any)
		mention := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "mentionsIssues")[0].(map[string]any)

		assert.Equal(t, "closes", closes["relation"])
		assert.Equal(t, "mentions", mention["relation"])
		require.NotEmpty(t, closes["pageUrl"])
	})
}
