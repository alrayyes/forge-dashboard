package dashboard_test

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// wireOf runs a check through WithFacts and reads back the keys it sends.
func wireOf(t *testing.T, state dashboard.CheckState) map[string]any {
	t.Helper()

	checks := dashboard.WithFacts([]dashboard.Check{{Name: "build", State: state, URL: "https://x/1"}})
	raw, err := json.Marshal(checks[0])
	require.NoError(t, err)

	var got map[string]any
	require.NoError(t, json.Unmarshal(raw, &got))

	return got
}

func TestWithFacts_SendsStatusAndConclusionNotState(t *testing.T) {
	t.Parallel()

	cases := []struct {
		state      dashboard.CheckState
		status     string
		conclusion any
	}{
		{dashboard.CheckQueued, "queued", nil},
		{dashboard.CheckRunning, "in_progress", nil},
		{dashboard.CheckAwaitingApproval, "waiting", nil},
		{dashboard.CheckSuccess, "completed", "success"},
		{dashboard.CheckFailure, "completed", "failure"},
		{dashboard.CheckCancelled, "completed", "cancelled"},
		{dashboard.CheckSkipped, "completed", "skipped"},
		{dashboard.CheckTimedOut, "completed", "timed_out"},
	}
	for _, c := range cases {
		t.Run(string(c.state), func(t *testing.T) {
			t.Parallel()

			got := wireOf(t, c.state)

			assert.NotContains(t, got, "state")
			assert.Equal(t, c.status, got["status"])
			assert.Equal(t, c.conclusion, got["conclusion"])
		})
	}
}

// checkStatesInModel reads every CheckState constant out of model.go, so a
// state added later is covered without anyone remembering to list it here.
func checkStatesInModel(t *testing.T) []dashboard.CheckState {
	t.Helper()

	file, err := parser.ParseFile(token.NewFileSet(), "model.go", nil, 0)
	require.NoError(t, err)

	var states []dashboard.CheckState
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			v := spec.(*ast.ValueSpec)
			if id, ok := v.Type.(*ast.Ident); !ok || id.Name != "CheckState" {
				continue
			}
			lit := v.Values[0].(*ast.BasicLit)
			value, err := strconv.Unquote(lit.Value)
			require.NoError(t, err)
			states = append(states, dashboard.CheckState(value))
		}
	}

	return states
}

// enumOf reads a string enum from components.schemas in the OpenAPI spec.
func enumOf(t *testing.T, doc *openapi3.T, schema string) []string {
	t.Helper()

	var out []string
	for _, v := range doc.Components.Schemas[schema].Value.Enum {
		out = append(out, v.(string))
	}

	return out
}

func TestWithFacts_EveryStateMapsToAnEnumValueTheSpecAllows(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	statuses := enumOf(t, doc, "CheckStatus")
	conclusions := enumOf(t, doc, "CheckConclusion")
	states := checkStatesInModel(t)
	require.NotEmpty(t, states)

	for _, s := range states {
		t.Run(string(s), func(t *testing.T) {
			t.Parallel()

			got := dashboard.WithFacts([]dashboard.Check{{State: s}})[0]

			assert.Contains(t, statuses, string(got.Status))
			if got.Status == dashboard.CheckStatusCompleted {
				assert.Contains(t, conclusions, string(got.Conclusion))
			} else {
				assert.Empty(t, got.Conclusion)
			}
		})
	}
}

func TestWithFacts_KeepsTheOtherFieldsAndTheStateInProcess(t *testing.T) {
	t.Parallel()

	out := dashboard.WithFacts([]dashboard.Check{{
		Name: "build", State: dashboard.CheckRunning, URL: "https://x/1",
		JobID: 3, RunID: 7, RunName: "ci", RunNumber: 9, RunAttempt: 2,
	}})

	assert.Equal(t, dashboard.CheckRunning, out[0].State)
	assert.Equal(t, int64(7), out[0].RunID)
	assert.Equal(t, int64(2), out[0].RunAttempt)
}

func TestWithFacts_LeavesTheSourcesListAlone(t *testing.T) {
	t.Parallel()

	in := []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess}}

	dashboard.WithFacts(in)

	assert.Empty(t, in[0].Status)
}

func TestWithFacts_KeepsANilListNil(t *testing.T) {
	t.Parallel()

	assert.Nil(t, dashboard.WithFacts(nil))
}
