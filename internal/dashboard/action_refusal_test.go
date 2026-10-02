package dashboard_test

import (
	"errors"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func refusal(kind dashboard.ForgeErrorKind, text string) error {
	return &dashboard.ClientError{Kind: kind, Err: errors.New(text)}
}

func TestClassifyActionRefusal(t *testing.T) {
	t.Parallel()

	notMergeable := refusal(dashboard.ForgeErrorConflict, "github: PUT /repos/o/r/pulls/5/merge: Pull Request is not mergeable")
	headModified := refusal(dashboard.ForgeErrorConflict, "github: PUT /repos/o/r/pulls/5/merge: Head branch was modified. Review and try the merge again.")
	checkPending := refusal(dashboard.ForgeErrorConflict, `github: PUT /repos/o/r/pulls/5/merge: Required status check "ci" is expected.`)
	checkFailing := refusal(dashboard.ForgeErrorConflict, `github: PUT /repos/o/r/pulls/5/merge: Required status check "ci" is failing.`)
	review := refusal(dashboard.ForgeErrorConflict, "github: PUT /repos/o/r/pulls/5/merge: At least 1 approving review is required by reviewers with write access.")

	cases := []struct {
		name  string
		err   error
		state *dashboard.PullRequestState
		code  dashboard.ActionCode
	}{
		{"already merged", notMergeable, &dashboard.PullRequestState{Merged: true, Closed: true}, dashboard.ActionAlreadyMerged},
		{"closed unmerged", notMergeable, &dashboard.PullRequestState{Closed: true}, dashboard.ActionAlreadyClosed},
		{"conflicting", notMergeable, &dashboard.PullRequestState{Conflicting: true}, dashboard.ActionConflict},
		{"behind", notMergeable, &dashboard.PullRequestState{Behind: true}, dashboard.ActionBehind},
		{"draft", notMergeable, &dashboard.PullRequestState{Draft: true}, dashboard.ActionNotMergeable},
		{"unstable checks", notMergeable, &dashboard.PullRequestState{ChecksFailing: true}, dashboard.ActionChecksFailing},
		{"blocked, no hint", notMergeable, &dashboard.PullRequestState{Blocked: true}, dashboard.ActionBlockedByProtection},
		{"blocked, pending check text", checkPending, &dashboard.PullRequestState{Blocked: true}, dashboard.ActionChecksPending},
		{"blocked, failing check text", checkFailing, &dashboard.PullRequestState{Blocked: true}, dashboard.ActionChecksFailing},
		{"blocked, review text", review, &dashboard.PullRequestState{Blocked: true}, dashboard.ActionBlockedByProtection},
		{"open and clean, generic 405", notMergeable, &dashboard.PullRequestState{}, dashboard.ActionNotMergeable},
		{"open and clean, 409 head modified", headModified, &dashboard.PullRequestState{}, dashboard.ActionNotMergeable},
		{"re-read failed", notMergeable, nil, dashboard.ActionUnknown},
		{"permission needs no re-read", refusal(dashboard.ForgeErrorUnauthorized, "github: PUT x: Resource not accessible"), nil, dashboard.ActionPermission},
		{"rate limited needs no re-read", refusal(dashboard.ForgeErrorRateLimited, "github: PUT x: rate limit exceeded"), nil, dashboard.ActionRateLimited},
		{"unreachable forge", refusal(dashboard.ForgeErrorUnreachable, "github: PUT x: dial tcp: refused"), nil, dashboard.ActionUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got := dashboard.ClassifyActionRefusal(tc.err, tc.state)

			assert.Equal(t, tc.code, got.Code)
			assert.NotEmpty(t, got.Message)
		})
	}
}

func TestClassifyActionRefusal_UnknownKeepsTheForgesOwnReasonWithoutTheDiagnosticPrefix(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusal(refusal(dashboard.ForgeErrorUnknown, "github: PUT /repos/o/r/pulls/5/merge: Something odd"), nil)

	assert.Equal(t, dashboard.ActionUnknown, got.Code)
	assert.Equal(t, "Something odd", got.Message)
}

func TestClassifyActionRefusal_RateLimitedCarriesResetsAt(t *testing.T) {
	t.Parallel()

	reset := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	err := &dashboard.ClientError{
		Kind:      dashboard.ForgeErrorRateLimited,
		Err:       errors.New("github: PUT x: rate limit exceeded"),
		RateLimit: &dashboard.RateLimit{ResetsAt: reset},
	}

	got := dashboard.ClassifyActionRefusal(err, nil)

	require.NotNil(t, got.ResetsAt)
	assert.True(t, reset.Equal(*got.ResetsAt))
}

func TestClassifyActionRefusal_NotAClientError_IsUnknown(t *testing.T) {
	t.Parallel()

	got := dashboard.ClassifyActionRefusal(errors.New("boom"), nil)

	assert.Equal(t, dashboard.ActionUnknown, got.Code)
	assert.Equal(t, "boom", got.Message)
}
