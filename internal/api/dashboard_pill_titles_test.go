package api_test

import (
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func titleOf(t *testing.T, list []any, number int) (string, bool) {
	t.Helper()
	for _, raw := range list {
		entry := raw.(map[string]any)
		if int(entry["number"].(float64)) == number {
			title, ok := entry["title"].(string)

			return title, ok
		}
	}
	require.Failf(t, "not in the list", "number %d", number)

	return "", false
}

// A pill can show what its target is called, so the board sends the title it
// already holds (#4326). A client words the pill without one that is missing.
func TestDashboard_PillsCarryTheTitleOfTheirTarget(t *testing.T) {
	t.Parallel()

	srvURL, cookie := linkedServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "?includeDrafts=true")

	t.Run("a pull request's closing issue has the issue's title", func(t *testing.T) {
		t.Parallel()
		title, ok := titleOf(t, listOf(t, body, "pullRequests", "github:alrayyes/a#20", "closesIssues"), 1)

		assert.True(t, ok)
		assert.Equal(t, "issue 1", title)
	})
	t.Run("a lowercased forgejo reference finds the mixed-case repo's issue", func(t *testing.T) {
		t.Parallel()
		title, ok := titleOf(t, listOf(t, body, "pullRequests", "forgejo:Ryan/Hush#7", "closesIssues"), 3)

		assert.True(t, ok)
		assert.Equal(t, "issue 3", title)
	})
	t.Run("an issue's linked pull requests have the pull request's title", func(t *testing.T) {
		t.Parallel()
		list := listOf(t, body, "issues", "github:alrayyes/a#1", "linkedPullRequests")

		first, _ := titleOf(t, list, 10)
		second, _ := titleOf(t, list, 20)
		assert.Equal(t, "pr 10", first)
		assert.Equal(t, "pr 20", second)
	})
}

// A mention of something the board does not hold has no title to send, and
// the key is left out rather than sent empty.
func TestDashboard_MentionsOfUnheldItemsLeaveTheTitleOut(t *testing.T) {
	t.Parallel()

	srvURL, cookie := mentionsServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "")
	list := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "mentionsIssues")

	held, ok := titleOf(t, list, 2)
	assert.True(t, ok)
	assert.Equal(t, "issue 2", held)

	_, ok = titleOf(t, list, 99)
	assert.False(t, ok, "an issue the board does not hold has no title key")
}

// The title is optional in all three pill shapes: a client that doesn't know
// it still has a pill to draw.
func TestContract_PillTitlesAreOptionalStrings(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	for _, name := range []string{"ClosingIssue", "MentionedIssue", "LinkedPullRequest"} {
		schema := doc.Components.Schemas[name].Value
		title := schema.Properties["title"]
		require.NotNil(t, title, "%s has a title", name)
		assert.True(t, title.Value.Type.Is("string"), name)
		assert.NotContains(t, schema.Required, "title", name)
	}
}
