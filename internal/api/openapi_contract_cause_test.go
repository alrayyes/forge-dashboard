package api_test

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ForgeHealth.cause says why a forge's rows are not fresh, and the page words
// it (#4998). The spec and the Go values must agree.
func TestContract_ForgeHealthCauseIsInTheSpec(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	schema := doc.Components.Schemas["ForgeHealth"].Value
	cause := schema.Properties["cause"]
	require.NotNil(t, cause, "ForgeHealth has a cause")

	var values []any
	values = append(values, cause.Value.Enum...)
	assert.ElementsMatch(t, []any{
		string(dashboard.ForgeCauseStarting),
		string(dashboard.ForgeCauseSlow),
	}, values)
	assert.NotContains(t, schema.Required, "cause")
}

func TestContract_ForgeHealthCauseIsOmittedWhenThereIsNone(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true})
	require.NoError(t, err)
	assert.NotContains(t, string(b), "cause")
}

func TestContract_ForgeHealthCauseIsSentWhenSet(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Cause: dashboard.ForgeCauseSlow})
	require.NoError(t, err)
	assert.Contains(t, string(b), `"cause":"slow"`)
}
