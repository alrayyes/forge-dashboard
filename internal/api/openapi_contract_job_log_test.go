package api_test

import (
	"net/http"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A check names the job whose output the dialog can read, and that output has
// one documented shape.
func TestContract_JobLog(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	t.Run("a check may carry a job id", func(t *testing.T) {
		t.Parallel()

		prop := doc.Components.Schemas["Check"].Value.Properties["jobId"]
		require.NotNil(t, prop)
		assert.True(t, prop.Value.Type.Is("integer"))
	})
	t.Run("the log answers text and a truncated flag", func(t *testing.T) {
		t.Parallel()

		op := doc.Paths.Find("/api/checks/log").Get
		require.NotNil(t, op)
		assert.Equal(t, "getCheckLog", op.OperationID)

		log := doc.Components.Schemas["CheckLog"].Value
		assert.ElementsMatch(t, []string{"text", "truncated"}, log.Required)
	})
	t.Run("the log takes an excerpt flag", func(t *testing.T) {
		t.Parallel()

		var found *openapi3.Parameter
		for _, p := range doc.Paths.Find("/api/checks/log").Get.Parameters {
			if p.Value.Name == "excerpt" {
				found = p.Value
			}
		}
		require.NotNil(t, found)
		assert.False(t, found.Required)
		assert.True(t, found.Schema.Value.Type.Is("boolean"))
	})
	t.Run("a real answer validates against the spec", func(t *testing.T) {
		t.Parallel()

		source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"a/b"}, log: dashboard.JobLog{Text: "ok\n", Truncated: true}}
		srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

		req, got := record(t, http.MethodGet, srvURL+"/api/checks/log?forge=github&fullName=a/b&jobId=5", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	})
}
