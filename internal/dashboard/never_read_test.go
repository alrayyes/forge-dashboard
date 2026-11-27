package dashboard_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A forge whose first read is slow has no rows. That says nothing about which
// pull requests are open, so nothing may be forgotten or skipped for it.

func TestClaimOf_AForgeNeverReadIsCarriedOver(t *testing.T) {
	t.Parallel()
	h := dashboard.ForgeHealth{Reachable: true, Cause: dashboard.ForgeCauseSlow}

	c := dashboard.ClaimOf(dashboard.ClaimState, h, true)

	assert.Equal(t, dashboard.ClaimCarriedOver, c.State)
	assert.False(t, c.ActionsOpen)
	assert.Nil(t, c.Since)
}

func TestClaimOf_ASlowForgeWithRowsIsStillConfirmed(t *testing.T) {
	t.Parallel()
	readAt := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	h := dashboard.ForgeHealth{Reachable: true, Cause: dashboard.ForgeCauseSlow, RowsReadAt: &readAt}

	assert.Equal(t, dashboard.ClaimConfirmed, dashboard.ClaimOf(dashboard.ClaimState, h, true).State)
}

func TestAggregator_ASlowFirstReadForgetsNoAutoUpdateChoice(t *testing.T) {
	t.Parallel()
	f := unreadLateFixture()
	f.src.slow.Store(true)
	lister := &fakeAutoUpdateBranchLister{
		enabled:   map[string]struct{}{"forgejo/o/r": {}},
		overrides: map[string]bool{"forgejo/o/r#10": false},
	}
	f.agg.EnableAutoUpdateBranch(lister)

	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	assert.Empty(t, lister.forgotten)
}

func TestAggregator_ASlowFirstReadLeavesAQueuedActionWaiting(t *testing.T) {
	t.Parallel()
	f := unreadLateFixture(dashboard.WithQueuedActionBuffer(0))
	f.src.slow.Store(true)
	store := openQueueStore(t, filepath.Join(t.TempDir(), "app.db"))
	f.agg.EnableQueuedActions(store)
	_, _, err := store.EnqueueQueuedAction(t.Context(), dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: 10,
		Status: dashboard.QueuedWaiting, RunAt: f.timers.Now().Add(-time.Minute), CreatedAt: f.timers.Now().Add(-2 * time.Hour),
	})
	require.NoError(t, err)

	// A person's refresh has left the read running when the action comes due.
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	f.agg.ProcessQueuedActions(t.Context())

	items, err := store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, dashboard.QueuedWaiting, items[0].Status, items[0].Message)
}
