package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestWithAutoMergeIntent_HeldBy(t *testing.T) {
	t.Parallel()

	on := true
	intents := map[string]struct{}{settings.AutoMergeKey("forgejo", "o/r", 7): {}}
	forgejoPR := func(n int, scheduled bool) dashboard.PullRequest {
		pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: n}
		if scheduled {
			pr.AutoMergeEnabled = &on
			pr.AutoMergeHeldBy = dashboard.AutoMergeHeldByForge
		}

		return pr
	}

	both := withAutoMergeIntent(forgejoPR(7, true), intents)
	require.NotNil(t, both.AutoMergeEnabled)
	assert.Equal(t, dashboard.AutoMergeHeldByDashboard, both.AutoMergeHeldBy, "the app's loop merges, so it wins")

	appOnly := withAutoMergeIntent(forgejoPR(7, false), intents)
	assert.Equal(t, dashboard.AutoMergeHeldByDashboard, appOnly.AutoMergeHeldBy)

	forgeOnly := withAutoMergeIntent(forgejoPR(8, true), intents)
	assert.Equal(t, dashboard.AutoMergeHeldByForge, forgeOnly.AutoMergeHeldBy)

	neither := withAutoMergeIntent(forgejoPR(8, false), intents)
	assert.Empty(t, neither.AutoMergeHeldBy)

	gh := withAutoMergeIntent(dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 7, AutoMergeHeldBy: dashboard.AutoMergeHeldByForge}, intents)
	assert.Equal(t, dashboard.AutoMergeHeldByForge, gh.AutoMergeHeldBy, "GitHub is always the forge")
}
