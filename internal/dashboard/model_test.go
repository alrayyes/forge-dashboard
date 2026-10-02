package dashboard_test

import (
	"encoding/json"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHumanizeForgeError_EveryKindGetsAMappedSentence proves every known
// ForgeErrorKind (and the zero value, plus an unrecognized one) resolves
// to a non-empty, human-written sentence rather than falling through to
// something that reads as unhandled (#360).
func TestHumanizeForgeError_EveryKindGetsAMappedSentence(t *testing.T) {
	t.Parallel()

	kinds := []dashboard.ForgeErrorKind{
		dashboard.ForgeErrorUnreachable,
		dashboard.ForgeErrorUnauthorized,
		dashboard.ForgeErrorNotFound,
		dashboard.ForgeErrorRateLimited,
		dashboard.ForgeErrorConflict,
		dashboard.ForgeErrorUnknown,
		dashboard.ForgeErrorKind("something-new-a-future-kind-might-add"),
	}

	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()

			assert.NotEmpty(t, dashboard.HumanizeForgeError(kind))
		})
	}
}

func TestHumanizeForgeError_UnrecognizedKind_FallsBackRatherThanEmpty(t *testing.T) {
	t.Parallel()

	msg := dashboard.HumanizeForgeError(dashboard.ForgeErrorKind("not-a-real-kind"))

	assert.Equal(t, "An unexpected error occurred talking to the forge.", msg)
}

func TestPullRequest_ReviewIsOmittedWhenUnknown(t *testing.T) {
	t.Parallel()

	unknown, err := json.Marshal(dashboard.PullRequest{})
	require.NoError(t, err)
	assert.NotContains(t, string(unknown), `"review"`)

	known, err := json.Marshal(dashboard.PullRequest{Review: &dashboard.ReviewState{
		Decision: dashboard.ReviewRequired, Approvals: 0, RequestedReviewers: 2,
	}})
	require.NoError(t, err)
	assert.Contains(t, string(known), `"review":{"decision":"review_required","approvals":0,"requestedReviewers":2}`)
}

func TestDeriveReviewDecision(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name                          string
		approvals, changes, requested int
		want                          dashboard.ReviewDecision
	}{
		{"nothing at all", 0, 0, 0, dashboard.ReviewNone},
		{"reviewers requested, nobody answered", 0, 0, 2, dashboard.ReviewRequired},
		{"an approval", 1, 0, 0, dashboard.ReviewApproved},
		{"approval but a reviewer is still requested", 1, 0, 1, dashboard.ReviewApproved},
		{"changes requested beats approval", 1, 1, 0, dashboard.ReviewChangesRequested},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, tc.want, dashboard.DeriveReviewDecision(tc.approvals, tc.changes, tc.requested))
		})
	}
}
