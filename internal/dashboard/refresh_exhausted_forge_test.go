package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// exhaustedGitHub is a GitHub source whose GraphQL budget is spent until
// resetsAt, holding one pull request.
func exhaustedGitHub(resetsAt time.Time) *fakeSource {
	return &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{
			Forge:            dashboard.ForgeGitHub,
			Reachable:        true,
			RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: resetsAt},
		},
		PullRequests: []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "o/r", Number: 1}},
	}}
}

func TestAggregator_Refresh_ForgeExhaustedUntilReset_IsNotCalledAgain(t *testing.T) {
	gh := exhaustedGitHub(time.Now().Add(time.Hour).UTC())
	agg := dashboard.NewAggregator([]dashboard.Source{gh})

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Equal(t, 1, gh.callCount(), "the second refresh must not spend a call on a forge with no budget")
	snap := agg.Get()
	assert.Len(t, snap.PullRequests, 1, "the last snapshot's rows stay")
	assert.Equal(t, 0, snap.Forges[0].RateLimitGraphQL.Remaining, "the exhausted budget stays visible so the banner holds")
}

func TestAggregator_Refresh_ExhaustedForgeDoesNotHoldBackTheOther(t *testing.T) {
	gh := exhaustedGitHub(time.Now().Add(time.Hour).UTC())
	fj := &fakeSource{result: dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
	}}
	agg := dashboard.NewAggregator([]dashboard.Source{gh, fj})

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Equal(t, 1, gh.callCount())
	assert.Equal(t, 2, fj.callCount(), "the healthy forge keeps refreshing")
}

func TestAggregator_Refresh_ForgeResetTimePassed_IsCalledAgain(t *testing.T) {
	gh := exhaustedGitHub(time.Now().Add(-time.Minute).UTC())
	agg := dashboard.NewAggregator([]dashboard.Source{gh})

	agg.Refresh(t.Context())
	agg.Refresh(t.Context())

	assert.Equal(t, 2, gh.callCount())
}

func TestNextRefreshDelay_ExhaustedForgeIsSkippedSoItDoesNotSlowTheLoop(t *testing.T) {
	snap := dashboard.Snapshot{Forges: []dashboard.ForgeHealth{{
		Forge:            dashboard.ForgeGitHub,
		RateLimitGraphQL: &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: time.Now().Add(time.Hour)},
	}}}

	assert.Equal(t, time.Minute, dashboard.NextRefreshDelay(snap, time.Minute))
}
