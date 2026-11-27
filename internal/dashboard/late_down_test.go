package dashboard_test

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A forge shown as down stays down while it is read again. Nothing about it has
// been confirmed until a read succeeds.

func failedRead(kind dashboard.ForgeErrorKind) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, ErrorKind: kind}}
}

// takeDown has a fixture's forge answer one read with a refusal.
func (f lateFixture) takeDown(t *testing.T) {
	t.Helper()

	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	f.src.answer <- failedRead(dashboard.ForgeErrorUnauthorized)
	f.shows(t, func(s dashboard.Snapshot) bool { return !health(s, dashboard.ForgeForgejo).Reachable })
	f.agg.WaitSourcesIdleForTest()
}

// assertDown checks the forge is shown as down, with its rows kept and closed to
// actions.
func assertDown(t *testing.T, snap dashboard.Snapshot, kind dashboard.ForgeErrorKind) {
	t.Helper()

	h := health(snap, dashboard.ForgeForgejo)
	assert.False(t, h.Reachable)
	assert.Equal(t, kind, h.ErrorKind)
	assert.Empty(t, h.Cause)
	assert.NotNil(t, h.StaleSince)
	assert.False(t, dashboard.ClaimOf(dashboard.ClaimAction, h, true).ActionsOpen)
	assert.Equal(t, []int{10}, numbers(snap))
}

func TestAggregator_ADownForgeBeingReadAgainStaysDown(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.takeDown(t)

	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	assertDown(t, f.agg.Get(), dashboard.ForgeErrorUnauthorized)
	f.agg.Refresh(t.Context()) // a pass behind the running read

	assertDown(t, f.agg.Get(), dashboard.ForgeErrorUnauthorized)
}

func TestAggregator_ADownForgeWhoseNextReadStaysSilentStaysDown(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.takeDown(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	f.timers.Advance(lateScheduledDeadline - lateUserDeadline)
	<-f.src.cancelled

	assertDown(t, f.agg.Get(), dashboard.ForgeErrorUnreachable)
}

func TestAggregator_ADownForgeWhoseNextReadFailsLateStaysDown(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.takeDown(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	f.src.answer <- failedRead(dashboard.ForgeErrorUpstream)

	f.shows(t, func(s dashboard.Snapshot) bool {
		return health(s, dashboard.ForgeForgejo).ErrorKind == dashboard.ForgeErrorUpstream
	})
	assertDown(t, f.agg.Get(), dashboard.ForgeErrorUpstream)
}

func TestAggregator_ADownForgeIsUpOnceALateReadSucceeds(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.takeDown(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	f.src.answer <- f.src.rows(11)

	f.shows(t, hasLateRow)
	assert.True(t, health(f.agg.Get(), dashboard.ForgeForgejo).Reachable)
}

// The rows are from before the outage, so they can't decide a queued action.
func TestAggregator_AQueuedActionOnADownForgeWaitsWhileItIsReadAgain(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t, dashboard.WithQueuedActionBuffer(0))
	f.takeDown(t)
	store := openQueueStore(t, filepath.Join(t.TempDir(), "app.db"))
	f.agg.EnableQueuedActions(store)
	_, _, err := store.EnqueueQueuedAction(t.Context(), dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: 10,
		Status: dashboard.QueuedWaiting, RunAt: f.timers.Now().Add(-time.Minute), CreatedAt: f.timers.Now().Add(-2 * time.Hour),
	})
	require.NoError(t, err)

	f.giveUp(t, func() { f.agg.ProcessQueuedActions(t.Context()) })

	items, err := store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, items, 1)
	assert.Equal(t, dashboard.QueuedWaiting, items[0].Status, items[0].Message)
}
