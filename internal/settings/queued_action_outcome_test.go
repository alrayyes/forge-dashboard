package settings_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_UpdateQueuedAction_RecordsTheOutcome(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	finished := time.Date(2026, 10, 11, 14, 33, 0, 0, time.UTC)
	saved.Status, saved.FinishedAt = dashboard.QueuedSkipped, &finished
	saved.Code, saved.Message = dashboard.ActionNotOpen, "Already merged or closed."

	found, err := store.UpdateQueuedAction(t.Context(), []byte("user-1"), saved)

	require.NoError(t, err)
	assert.True(t, found)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	require.Len(t, got, 1)
	assert.Equal(t, dashboard.QueuedSkipped, got[0].Status)
	assert.Equal(t, dashboard.ActionNotOpen, got[0].Code)
	assert.Equal(t, "Already merged or closed.", got[0].Message)
	require.NotNil(t, got[0].FinishedAt)
	assert.True(t, finished.Equal(*got[0].FinishedAt))
}

func TestStore_UpdateQueuedAction_CanMoveTheReset(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	later := time.Now().Add(3 * time.Hour).UTC()
	saved.RunAt = later

	_, err = store.UpdateQueuedAction(t.Context(), []byte("user-1"), saved)

	require.NoError(t, err)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.True(t, later.Equal(got[0].RunAt))
}

func TestStore_UpdateQueuedAction_CancelledMeanwhile_DoesNotComeBack(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	_, err = store.CancelQueuedAction(t.Context(), []byte("user-1"), saved.ID)
	require.NoError(t, err)
	saved.Status = dashboard.QueuedDone

	found, err := store.UpdateQueuedAction(t.Context(), []byte("user-1"), saved)

	require.NoError(t, err)
	assert.False(t, found)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.Empty(t, got)
}

func TestStore_UpdateQueuedAction_AFinishedOneStaysFinished(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	saved.Status = dashboard.QueuedDone
	_, err = store.UpdateQueuedAction(t.Context(), []byte("user-1"), saved)
	require.NoError(t, err)
	saved.Status = dashboard.QueuedFailed

	found, err := store.UpdateQueuedAction(t.Context(), []byte("user-1"), saved)

	require.NoError(t, err)
	assert.False(t, found, "only a waiting item can be updated")
}

func TestStore_PruneQueuedActions_DropsOldFinishedOnesOnly(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	user := []byte("user-1")
	now := time.Now().UTC()
	enqueue := func(number int) dashboard.QueuedAction {
		q := queuedUpdate(now)
		q.Number = number
		saved, _, err := store.EnqueueQueuedAction(t.Context(), user, q)
		require.NoError(t, err)

		return saved
	}
	finish := func(q dashboard.QueuedAction, at time.Time) {
		q.Status, q.FinishedAt = dashboard.QueuedDone, &at
		_, err := store.UpdateQueuedAction(t.Context(), user, q)
		require.NoError(t, err)
	}
	finish(enqueue(5), now.Add(-48*time.Hour))
	finish(enqueue(6), now.Add(-time.Hour))
	enqueue(7)

	require.NoError(t, store.PruneQueuedActions(t.Context(), user, now.Add(-24*time.Hour)))

	got, _ := store.QueuedActions(t.Context(), user)
	assert.Len(t, got, 2)
}

func TestStore_UsersWithWaitingQueuedActions(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	done, _, err := store.EnqueueQueuedAction(t.Context(), []byte("user-2"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	done.Status = dashboard.QueuedDone
	_, err = store.UpdateQueuedAction(t.Context(), []byte("user-2"), done)
	require.NoError(t, err)

	got, err := store.UsersWithWaitingQueuedActions(t.Context())

	require.NoError(t, err)
	assert.Equal(t, [][]byte{[]byte("user-1")}, got)
}
