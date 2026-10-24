package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every pull request lists the tickets it mentions and every issue the pull
// requests that mention it, always as arrays, and the spec says what an entry
// is, so a client can rely on both.
func TestContract_MentionsAreInTheSpecAndTheResponse(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	t.Run("the pull request requires mentionsIssues and describes its entries", func(t *testing.T) {
		t.Parallel()

		pr := doc.Components.Schemas["PullRequest"].Value
		require.Contains(t, pr.Required, "mentionsIssues")
		items := pr.Properties["mentionsIssues"].Value.Items.Value

		assert.ElementsMatch(t, []string{"repo", "number", "url", "pageUrl", "tracked"}, items.Required)
	})
	t.Run("the issue requires mentionedByPullRequests and reuses the linked entry", func(t *testing.T) {
		t.Parallel()

		issue := doc.Components.Schemas["Issue"].Value
		require.Contains(t, issue.Required, "mentionedByPullRequests")

		assert.Equal(t, "#/components/schemas/LinkedPullRequest", issue.Properties["mentionedByPullRequests"].Value.Items.Ref)
	})
	t.Run("every pull request and issue in the response has the array", func(t *testing.T) {
		t.Parallel()

		srvURL, cookie := mentionsServer(t)
		req, got := record(t, http.MethodGet, srvURL+"/api/dashboard", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			PullRequests []map[string]any `json:"pullRequests"`
			Issues       []map[string]any `json:"issues"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.NotEmpty(t, body.PullRequests)
		require.NotEmpty(t, body.Issues)
		for _, p := range body.PullRequests {
			assert.IsType(t, []any{}, p["mentionsIssues"], "pull request %v", p["number"])
		}
		for _, i := range body.Issues {
			assert.IsType(t, []any{}, i["mentionedByPullRequests"], "issue %v", i["number"])
		}
	})
}
