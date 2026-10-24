package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func boxPR(ticked bool) dashboard.PullRequest {
	pr := botPR("a", true, dashboard.CIFailure)
	pr.RenovateRebaseRequested = ticked

	return pr
}

func TestAggregator_SetRenovateRebaseBox(t *testing.T) {
	t.Parallel()

	t.Run("clearing the box drops a Renovate request still waiting on it", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		agg.RecordBotRequest(dashboard.ForgeGitHub, "o/r", 7, dashboard.BotRenovate, dashboard.BotRebase)

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		assert.Nil(t, botRequestOf(t, agg))
	})

	t.Run("clearing the box leaves a Dependabot request alone", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		request(agg)

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		assert.NotNil(t, botRequestOf(t, agg))
	})

	t.Run("a pull request the snapshot does not hold is ignored and tells nobody", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 99, true)

		select {
		case <-ch:
			t.Fatal("a snapshot was pushed for an unknown pull request")
		case <-time.After(50 * time.Millisecond):
		}
	})

	t.Run("ticking the box shows it on the pull request", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))

		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		assert.True(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})

	t.Run("a fetch that read the description before a cancel can't bring the box back", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(true))
		agg, _ := botAggregator(t, src)
		src.mu.Lock()
		src.gate, src.started = make(chan struct{}), make(chan struct{})
		gate, started := src.gate, src.started
		src.mu.Unlock()

		done := make(chan struct{})
		go func() { agg.Refresh(t.Context()); close(done) }()
		<-started
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)
		close(gate)
		<-done

		assert.False(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})

	t.Run("a fetch that starts after the cancel reads the forge again", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(true))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, false)

		agg.Refresh(t.Context())

		assert.True(t, agg.Get().PullRequests[0].RenovateRebaseRequested)
	})
}

func TestAggregator_RecordRenovateRebase(t *testing.T) {
	t.Parallel()

	t.Run("one snapshot carries both the request and the ticked box", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		ch, unsubscribe := agg.Subscribe()
		defer unsubscribe()

		agg.RecordRenovateRebase(dashboard.ForgeGitHub, "o/r", 7)

		select {
		case snap := <-ch:
			require.Len(t, snap.PullRequests, 1)
			assert.NotNil(t, snap.PullRequests[0].BotRequest)
			assert.True(t, snap.PullRequests[0].RenovateRebaseRequested)
		case <-time.After(time.Second):
			t.Fatal("no snapshot pushed")
		}

		select {
		case <-ch:
			t.Fatal("a second snapshot was pushed for one request")
		case <-time.After(50 * time.Millisecond):
		}
	})
}

func TestAggregator_ReapplyBoxOverrides(t *testing.T) {
	t.Parallel()

	t.Run("a snapshot from a fetch that started before the tick keeps the tick", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		prs := []dashboard.PullRequest{boxPR(false)}

		agg.ReapplyBoxOverrides(prs, 1)

		assert.True(t, prs[0].RenovateRebaseRequested)
	})

	t.Run("a snapshot from a fetch that started after the tick is left as read", func(t *testing.T) {
		t.Parallel()
		agg, _ := botAggregator(t, newBotSource(boxPR(false)))
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		prs := []dashboard.PullRequest{boxPR(false)}

		agg.ReapplyBoxOverrides(prs, 2)

		assert.False(t, prs[0].RenovateRebaseRequested)
	})
}

func TestAggregator_BoxOverrideLifetime(t *testing.T) {
	t.Parallel()

	t.Run("a pull request that leaves the board takes its override with it", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)
		require.Equal(t, 1, agg.BoxOverrideCount())

		src.set()
		agg.Refresh(t.Context())

		assert.Zero(t, agg.BoxOverrideCount())
	})

	t.Run("a forge that failed to answer keeps the override", func(t *testing.T) {
		t.Parallel()
		src := newBotSource(boxPR(false))
		agg, _ := botAggregator(t, src)
		agg.SetRenovateRebaseBox(dashboard.ForgeGitHub, "o/r", 7, true)

		src.mu.Lock()
		src.reachable = false
		src.mu.Unlock()
		agg.Refresh(t.Context())

		assert.Equal(t, 1, agg.BoxOverrideCount())
	})
}
