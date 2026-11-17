package api

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A host that can't be asked blocks every action on its rows with the claim
// rule's reason, whatever else the board does to the list: a repo that updates
// its branches itself, or a release pull request that auto-update skips
// (#3994). Neither may open an action or swap the reason for another one.
func TestBoardAllowedActions_ForgeThatCantBeAsked(t *testing.T) {
	t.Parallel()

	since := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for name, health := range map[string]dashboard.ForgeHealth{
		"unreachable": {Forge: dashboard.ForgeGitHub, StaleSince: &since},
		"starting":    {Forge: dashboard.ForgeGitHub, Starting: true, StaleSince: &since},
	} {
		release := dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 2, Author: "release-please[bot]",
			Labels: []dashboard.Label{{Name: "autorelease: pending"}}, Behind: true,
			CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
		}
		regular := dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1, Author: "alice", Behind: true,
			CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
		}
		require.Equal(t, dashboard.KindRelease, dashboard.KindOf(release, nil), "the fixture is a release pull request")

		repoAuto := map[string]struct{}{settings.WebhookDeliveryKey("github", "o/r"): {}}
		cases := map[string]struct {
			board boardSettings
			pr    dashboard.PullRequest
		}{
			"auto-update on":             {boardSettings{autoUpdateBranch: repoAuto}, regular},
			"release, no auto-update":    {boardSettings{}, release},
			"release, auto-update":       {boardSettings{autoUpdateBranch: repoAuto}, release},
			"auto-update chosen for one": {boardSettings{autoUpdateChoices: map[string]bool{settings.AutoMergeKey("github", "o/r", 1): true}}, regular},
		}
		for caseName, tc := range cases {
			t.Run(name+"/"+caseName, func(t *testing.T) {
				t.Parallel()

				tc.board.forges = []dashboard.ForgeHealth{health}
				actions := tc.board.allowedActions(tc.pr)

				require.NotEmpty(t, actions)
				names := map[dashboard.ActionName]bool{}
				for _, a := range actions {
					names[a.Action] = true
					require.NotNil(t, a.Blocked, "%s is open on a forge that can't be asked", a.Action)
					assert.Equal(t, dashboard.ActionForgeUnreachable, a.Blocked.Code, a.Action)
					assert.Empty(t, a.Blocked.Next, "%s keeps the claim's reason, not a next step for being behind", a.Action)
					assert.False(t, a.Primary, a.Action)
				}
				assert.True(t, names[dashboard.ActionMerge], "Merge stays listed, blocked")
			})
		}
	}
}
