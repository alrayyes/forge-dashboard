package api_test

import (
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Closing, referencing and mentioning entries are one shape with a relation,
// and every pull request carries refsIssues as an array.
func TestContract_RefsAreInTheSpec(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	pr := doc.Components.Schemas["PullRequest"].Value
	require.Contains(t, pr.Required, "refsIssues")
	items := pr.Properties["refsIssues"].Value.Items.Value
	assert.Subset(t, items.Required, []string{"repo", "number", "url", "pageUrl", "tracked", "relation"})

	relation := doc.Components.Schemas["ClosingIssue"].Value.Properties["relation"].Value
	var values []any
	values = append(values, relation.Enum...)
	assert.ElementsMatch(t, []any{"closes", "refs", "mentions"}, values)
}

// The issue carries the other side of refsIssues, in the linked entry.
func TestContract_IssueRequiresReferencedByPullRequests(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	issue := doc.Components.Schemas["Issue"].Value
	require.Contains(t, issue.Required, "referencedByPullRequests")
	assert.Equal(t, "#/components/schemas/LinkedPullRequest", issue.Properties["referencedByPullRequests"].Value.Items.Ref)
}
