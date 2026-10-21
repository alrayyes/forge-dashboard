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

		assert.ElementsMatch(t, []string{"passed", "running", "waiting", "failed", "skipped"}, checks.Required)
		for _, name := range []string{"passed", "running", "waiting", "failed", "skipped"} {
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
			for _, name := range []string{"passed", "running", "waiting", "failed", "skipped"} {
				assert.IsType(t, float64(0), checks[name], "pull request %v, %s", p["number"], name)
			}
		}
	})
}

// Every default branch says the same four counts a pull request does, always
// present, so the Branches page draws its pills without a second request.
func TestContract_MainBranchesCarryCheckCounts(t *testing.T) {
	t.Parallel()

	t.Run("the spec requires checks, of the same schema as a pull request", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		branch := doc.Components.Schemas["MainBranch"].Value
		require.Contains(t, branch.Required, "checks")
		assert.Equal(t, "#/components/schemas/CheckCounts", branch.Properties["checks"].Ref)
	})
	t.Run("every branch in the response has the four counts", func(t *testing.T) {
		t.Parallel()

		srv, cookie := populatedBoard(t)
		req, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			Branches []map[string]any `json:"branches"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.NotEmpty(t, body.Branches)
		for _, b := range body.Branches {
			checks, ok := b["checks"].(map[string]any)
			require.True(t, ok, "branch %v has no checks object", b["fullName"])
			for _, name := range []string{"passed", "running", "waiting", "failed", "skipped"} {
				assert.IsType(t, float64(0), checks[name], "branch %v, %s", b["fullName"], name)
			}
		}
	})
}

// Every default branch names its latest published release or says null, always
// present, so the Branches page links it without a lookup of its own.
func TestContract_MainBranchesCarryLatestRelease(t *testing.T) {
	t.Parallel()

	t.Run("the spec requires a nullable latestRelease with a tag and a url", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		row := doc.Components.Schemas["MainBranch"].Value
		require.Contains(t, row.Required, "latestRelease")
		release := doc.Components.Schemas["MainBranchRelease"].Value

		assert.ElementsMatch(t, []string{"tag", "url"}, release.Required)
	})
	t.Run("every row in the response has the key", func(t *testing.T) {
		t.Parallel()

		srv, cookie := populatedBoard(t)
		req, got := record(t, http.MethodGet, srv.URL+"/api/main-branches", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			Branches []map[string]any `json:"branches"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.NotEmpty(t, body.Branches)
		var named int
		for _, b := range body.Branches {
			release, ok := b["latestRelease"]
			require.True(t, ok, "%v has no latestRelease key", b["fullName"])
			if release != nil {
				named++
			}
		}
		assert.Equal(t, 1, named, "one fixture row names a release, the rest say null")
	})
}
