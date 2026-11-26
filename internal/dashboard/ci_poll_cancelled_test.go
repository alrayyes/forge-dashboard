package dashboard_test

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// newPolledAggregator returns an Aggregator holding one pull request the CI
// poll reads on every tick: an armed one is never backed off.
func newPolledAggregator(t *testing.T) (*dashboard.Aggregator, *fakeRepoRefresherSource) {
	t.Helper()

	on := true
	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CISuccess, AutoMergeEnabled: &on},
	})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	return agg, src
}

func TestAggregator_RunCIPoll_AlreadyCancelled_PollsNothing(t *testing.T) {
	t.Parallel()

	synctest.Test(t, func(t *testing.T) {
		agg, src := newPolledAggregator(t)
		ctx, cancel := context.WithCancel(t.Context())
		cancel()

		agg.RunCIPoll(ctx, time.Minute)

		assert.Zero(t, src.repoFetchCallCount("alrayyes/a"))
	})
}

func TestAggregator_RunCIPoll_CancelledWithATickWaiting_StartsNoPoll(t *testing.T) {
	t.Parallel()

	for range selectRaceRuns {
		synctest.Test(t, func(t *testing.T) {
			agg, src := newPolledAggregator(t)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			src.onFetchRepo = func(string) {
				// The bubble's clock: the next tick is due once this returns.
				time.Sleep(2 * time.Minute)
				cancel()
			}

			agg.RunCIPoll(ctx, time.Minute)

			assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"), "only the poll that was running when the loop was cancelled")
		})
		if t.Failed() {
			return
		}
	}
}
