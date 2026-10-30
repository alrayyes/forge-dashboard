package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every pull request lists the issues it will close, always as an array, and
// the spec says what an entry is, so a client can rely on both.
func TestContract_PullRequestsCarryClosesIssues(t *testing.T) {
	t.Parallel()

	t.Run("the spec requires closesIssues and describes its entries", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		pr := doc.Components.Schemas["PullRequest"].Value
		require.Contains(t, pr.Required, "closesIssues")
		items := pr.Properties["closesIssues"].Value.Items.Value

		assert.ElementsMatch(t, []string{"repo", "number", "url", "pageUrl"}, items.Required)
	})
	t.Run("every pull request in the response has the array", func(t *testing.T) {
		t.Parallel()

		srv, cookie := populatedBoard(t)
		req, got := record(t, http.MethodGet, srv.URL+"/api/v1/dashboard?includeDrafts=true", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			PullRequests []map[string]any `json:"pullRequests"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.NotEmpty(t, body.PullRequests)
		for _, p := range body.PullRequests {
			assert.IsType(t, []any{}, p["closesIssues"], "pull request %v", p["number"])
		}
	})
}
