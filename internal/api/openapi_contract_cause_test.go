package api_test

import (
	"encoding/json"
	"testing"
	"time"

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

// While a forge is slow, its health says when the held rows were read, so the
// page can say how old they are (#5023).
func TestContract_ForgeHealthRowsReadAtIsInTheSpec(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	schema := doc.Components.Schemas["ForgeHealth"].Value
	at := schema.Properties["rowsReadAt"]
	require.NotNil(t, at, "ForgeHealth has a rowsReadAt")
	assert.Equal(t, "date-time", at.Value.Format)
	assert.NotContains(t, schema.Required, "rowsReadAt")
}

func TestContract_ForgeHealthRowsReadAtIsOmittedWhenThereIsNone(t *testing.T) {
	t.Parallel()

	b, err := json.Marshal(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true})
	require.NoError(t, err)
	assert.NotContains(t, string(b), "rowsReadAt")
}

func TestContract_ForgeHealthRowsReadAtIsSentWhenSet(t *testing.T) {
	t.Parallel()

	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	b, err := json.Marshal(dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, RowsReadAt: &at})
	require.NoError(t, err)
	assert.Contains(t, string(b), `"rowsReadAt":"2026-01-02T03:04:05Z"`)
}
