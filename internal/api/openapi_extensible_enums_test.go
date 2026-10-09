package api_test

import (
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
		"dependabot_rebase", "dependabot_recreate", "renovate_rebase", "rerun_checks",
	}
	knownBlockedCodes = []string{
		"already_up_to_date", "conflict", "not_mergeable", "checks_pending",
		"checks_failing", "behind", "blocked_by_protection", "stacked",
	}
)

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
