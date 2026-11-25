package api_test

import (
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

// AllowedAction.action and AllowedAction.blocked.code are meant to grow (#1054),
// so the spec declares them with x-extensible-enum: a new value is an additive
// SDK release, not a major. kin-openapi doesn't check membership for an
// extension, so these tests do. The lists below are the Go side of the
// contract: add a value here, in the spec, and where the server emits it.
var (
	knownActions = []string{
		"merge", "close", "update_branch", "auto_merge", "cancel_auto_merge",
		"dependabot_rebase", "dependabot_recreate", "renovate_rebase", "cancel_renovate_rebase", "rerun_checks", "cancel_run",
	}
	knownBlockedCodes = []string{
		"already_up_to_date", "conflict", "not_mergeable", "checks_pending",
		"checks_failing", "behind", "blocked_by_protection", "stacked", "already_requested",
		"forge_unreachable", "status_unknown",
	}
)

// knownActionErrorCodes is ActionError.code's list (#4907): a new refusal code
// is an additive SDK release too.
var knownActionErrorCodes = []string{
	"already_merged", "already_closed", "not_mergeable", "conflict", "behind",
	"checks_pending", "checks_failing", "blocked_by_protection", "already_up_to_date",
	"auto_merge_not_allowed", "ready_to_merge", "permission", "rate_limited",
	"forge_error", "forge_unreachable", "status_unknown", "not_rate_limited",
	"not_open", "not_reopenable", "label_missing", "stacked", "already_requested",
	"unknown",
}

// actionCodeConstants returns the value of every ActionCode constant declared
// in the dashboard package, read from the source so a new constant can't be
// missed by a hand-kept list (#4913).
func actionCodeConstants(t *testing.T) []string {
	t.Helper()

	file, err := parser.ParseFile(token.NewFileSet(), "../dashboard/action_refusal.go", nil, 0)
	require.NoError(t, err)

	var codes []string
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs := spec.(*ast.ValueSpec)
			if id, ok := vs.Type.(*ast.Ident); !ok || id.Name != "ActionCode" {
				continue
			}
			for _, v := range vs.Values {
				lit, ok := v.(*ast.BasicLit)
				require.True(t, ok, "ActionCode constants must be string literals")
				val, err := strconv.Unquote(lit.Value)
				require.NoError(t, err)
				codes = append(codes, val)
			}
		}
	}
	require.NotEmpty(t, codes)

	return codes
}

// knownAutoMergeHolders is PullRequest.autoMergeHeldBy's list (#1596): a new
// holder is an additive SDK release too.
var knownAutoMergeHolders = []string{"dashboard", "forge"}

func allowedActionSchema(t *testing.T) *openapi3.Schema {
	t.Helper()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	return doc.Components.Schemas["AllowedAction"].Value
}

func extensibleEnum(t *testing.T, s *openapi3.Schema) []string {
	t.Helper()

	raw, ok := s.Extensions["x-extensible-enum"].([]any)
	require.True(t, ok, "x-extensible-enum is missing")
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		out = append(out, v.(string))
	}

	return out
}

func TestAllowedActionSpec_ExtensibleEnumsMatchTheGoLists(t *testing.T) {
	t.Parallel()

	schema := allowedActionSchema(t)

	t.Run("action is extensible and lists what the server knows", func(t *testing.T) {
		t.Parallel()

		prop := schema.Properties["action"].Value
		assert.Empty(t, prop.Enum, "a closed enum would make every new value a major release")
		assert.ElementsMatch(t, knownActions, extensibleEnum(t, prop))
	})

	t.Run("blocked.code is extensible and lists what the server knows", func(t *testing.T) {
		t.Parallel()

		prop := schema.Properties["blocked"].Value.Properties["code"].Value
		assert.Empty(t, prop.Enum, "a closed enum would make every new value a major release")
		assert.ElementsMatch(t, knownBlockedCodes, extensibleEnum(t, prop))
	})
}

func TestPullRequestSpec_AutoMergeHeldByIsExtensible(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	prop := doc.Components.Schemas["PullRequest"].Value.Properties["autoMergeHeldBy"].Value

	t.Run("is not a closed enum", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, prop.Enum, "a closed enum would make every new holder a major release")
	})
	t.Run("lists what the server knows", func(t *testing.T) {
		t.Parallel()

		assert.ElementsMatch(t, knownAutoMergeHolders, extensibleEnum(t, prop))
	})
}

func TestActionErrorSpec_CodeIsExtensible(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	prop := doc.Components.Schemas["ActionError"].Value.Properties["code"].Value

	t.Run("is not a closed enum", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, prop.Enum, "a closed enum would make every new code a major release")
	})
	t.Run("lists what the server knows", func(t *testing.T) {
		t.Parallel()

		assert.ElementsMatch(t, knownActionErrorCodes, extensibleEnum(t, prop))
	})
	t.Run("lists every ActionCode constant the server defines", func(t *testing.T) {
		t.Parallel()

		assert.ElementsMatch(t, actionCodeConstants(t), extensibleEnum(t, prop),
			"add the code to ActionError.code in api/openapi.yaml")
	})
}

// dimension is one input that steers AllowedActions: each option sets it.
type dimension []func(*dashboard.PullRequest)

// every returns each combination of one option per dimension.
func every(dims ...dimension) []dashboard.PullRequest {
	prs := []dashboard.PullRequest{{}}
	for _, d := range dims {
		next := make([]dashboard.PullRequest, 0, len(prs)*len(d))
		for _, pr := range prs {
			for _, set := range d {
				c := pr
				set(&c)
				next = append(next, c)
			}
		}
		prs = next
	}

	return prs
}

func options[T any](set func(*dashboard.PullRequest, T), values ...T) dimension {
	d := make(dimension, 0, len(values))
	for _, v := range values {
		d = append(d, func(pr *dashboard.PullRequest) { set(pr, v) })
	}

	return d
}

// With the enum no longer closed, nothing else stops the server emitting a
// value the spec never mentioned. Walk the inputs that steer AllowedActions.
func TestAllowedActions_OnlyEmitsValuesTheSpecListsAsKnown(t *testing.T) {
	t.Parallel()

	tri := []*bool{nil, new(false), new(true)}
	prs := every(
		options(func(pr *dashboard.PullRequest, v dashboard.Forge) { pr.Forge = v }, dashboard.ForgeGitHub, dashboard.ForgeForgejo),
		options(func(pr *dashboard.PullRequest, v dashboard.CIStatus) { pr.CI = v }, dashboard.CISuccess, dashboard.CIFailure, dashboard.CIPending, dashboard.CINone),
		options(func(pr *dashboard.PullRequest, v dashboard.MergeStatus) { pr.MergeStatus = v },
			dashboard.MergeMergeable, dashboard.MergeConflicting, dashboard.MergeBlocked, dashboard.MergeUnstable, dashboard.MergeUnknown),
		options(func(pr *dashboard.PullRequest, v string) { pr.Author = v }, "alice", "dependabot[bot]", "dependabot", "renovate"),
		options(func(pr *dashboard.PullRequest, v bool) { pr.Behind = v }, false, true),
		options(func(pr *dashboard.PullRequest, v bool) { pr.Draft = v }, false, true),
		options(func(pr *dashboard.PullRequest, v bool) { pr.Empty = v }, false, true),
		options(func(pr *dashboard.PullRequest, v bool) { pr.RenovateRebaseRequested = v }, false, true),
		options(func(pr *dashboard.PullRequest, v *dashboard.StackRef) { pr.StackedOn = v }, nil, &dashboard.StackRef{Number: 1}),
		options(func(pr *dashboard.PullRequest, v *bool) { pr.AutoMergeEnabled = v }, tri...),
		options(func(pr *dashboard.PullRequest, v *bool) { pr.AutoMergeAllowed = v }, tri...),
	)

	for _, pr := range prs {
		for _, a := range dashboard.AllowedActions(pr, []string{"renovate"}) {
			assert.Contains(t, knownActions, string(a.Action), "action is emitted but not in the known list or the spec")
			if a.Blocked != nil {
				assert.Contains(t, knownBlockedCodes, string(a.Blocked.Code), "blocked code is emitted but not in the known list or the spec")
			}
		}
	}
}
