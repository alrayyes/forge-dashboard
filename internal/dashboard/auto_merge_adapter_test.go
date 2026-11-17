package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The list of actions and the refusal for a missing one come from one rule, so
// they can't disagree about whether auto-merge can be armed.
func TestAutoMergeArming_ListAndRefusalAgree(t *testing.T) {
	t.Parallel()

	pending := func(forge dashboard.Forge) dashboard.PullRequest {
		return dashboard.PullRequest{Forge: forge, MergeStatus: dashboard.MergeMergeable, CI: dashboard.CIPending}
	}
	offered := func(pr dashboard.PullRequest) bool {
		for _, a := range dashboard.AllowedActions(pr, nil) {
			if a.Action == dashboard.ActionAutoMerge {
				return true
			}
		}

		return false
	}

	forgejoDraft := pending(dashboard.ForgeForgejo)
	forgejoDraft.Draft = true
	githubDraft := pending(dashboard.ForgeGitHub)
	githubDraft.Draft = true

	tests := []struct {
		name string
		pr   dashboard.PullRequest
		want bool
	}{
		{"a Forgejo draft has nothing to arm", forgejoDraft, false},
		{"a GitHub draft can be armed", githubDraft, true},
		{"a Forgejo pull request waiting on checks", pending(dashboard.ForgeForgejo), true},
		{"a forge nobody knows", pending("nowhere"), false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			refusal, blocked := dashboard.AutoMergeBlock(tt.pr)

			assert.Equal(t, tt.want, offered(tt.pr), "the action list")
			assert.Equal(t, !tt.want, blocked, "the refusal agrees with the list")
			if blocked {
				assert.NotEmpty(t, refusal.Message)
			}
		})
	}

	draftRefusal, _ := dashboard.AutoMergeBlock(forgejoDraft)
	require.Equal(t, dashboard.ActionNotMergeable, draftRefusal.Code)
	assert.Contains(t, draftRefusal.Message, "Draft")
}

func TestAppMergesArmed_FollowsTheCapability(t *testing.T) {
	t.Parallel()

	assert.True(t, dashboard.AppMergesArmed(dashboard.ForgeForgejo))
	assert.False(t, dashboard.AppMergesArmed(dashboard.ForgeGitHub))
	assert.False(t, dashboard.AppMergesArmed("nowhere"))
}
