package api_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every pull request says how many of its checks passed, are running, are
// waiting and failed, always as four integers, so a client can draw them
// without a second request.
func TestContract_PullRequestsCarryCheckCounts(t *testing.T) {
	t.Parallel()

	t.Run("the spec requires checks and its four counts", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		pr := doc.Components.Schemas["PullRequest"].Value
		require.Contains(t, pr.Required, "checks")
		checks := pr.Properties["checks"].Value

		assert.ElementsMatch(t, []string{"passed", "running", "waiting", "failed"}, checks.Required)
		for _, name := range []string{"passed", "running", "waiting", "failed"} {
			assert.True(t, checks.Properties[name].Value.Type.Is("integer"), name)
		}
	})
	t.Run("every pull request in the response has the four counts", func(t *testing.T) {
		t.Parallel()

		srv, cookie := populatedBoard(t)
		req, got := record(t, http.MethodGet, srv.URL+"/api/dashboard?includeDrafts=true", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			PullRequests []map[string]any `json:"pullRequests"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.NotEmpty(t, body.PullRequests)
		for _, p := range body.PullRequests {
			checks, ok := p["checks"].(map[string]any)
			require.True(t, ok, "pull request %v has no checks object", p["number"])
			for _, name := range []string{"passed", "running", "waiting", "failed"} {
				assert.IsType(t, float64(0), checks[name], "pull request %v, %s", p["number"], name)
			}
		}
	})
}
