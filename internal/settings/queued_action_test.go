package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func queuedUpdate(runAt time.Time) dashboard.QueuedAction {
	return dashboard.QueuedAction{
		Action: dashboard.ActionUpdateBranch, Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5,
		Status: dashboard.QueuedWaiting, RunAt: runAt, CreatedAt: runAt.Add(-time.Minute),
	}
}

func TestStore_EnqueueQueuedAction_ThenQueuedActions_ReturnsItWithAnID(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	runAt := time.Date(2026, 10, 11, 14, 32, 0, 0, time.UTC)

	saved, created, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(runAt))
	require.NoError(t, err)

	got, err := store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.True(t, created)
	assert.NotEmpty(t, saved.ID)
	assert.Equal(t, saved.ID, got[0].ID)
	assert.Equal(t, dashboard.ActionUpdateBranch, got[0].Action)
	assert.Equal(t, dashboard.QueuedWaiting, got[0].Status)
	assert.True(t, runAt.Equal(got[0].RunAt), "runAt %s", got[0].RunAt)
}

func TestStore_EnqueueQueuedAction_SameActionTwice_KeepsTheFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	first, _, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	second, created, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(time.Now().Add(2*time.Hour)))
	require.NoError(t, err)

	assert.Equal(t, first.ID, second.ID)
	assert.False(t, created, "the second request created nothing")
	got, _ := store.QueuedActions(t.Context())
	assert.Len(t, got, 1)
}

func TestStore_QueuedActions_NoneQueued_ReturnsEmptyNotNil(t *testing.T) {
	t.Parallel()

	got, err := newTestStore(t).QueuedActions(t.Context())

	require.NoError(t, err)
	assert.NotNil(t, got)
	assert.Empty(t, got)
}

func TestStore_CancelQueuedAction_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	found, err := store.CancelQueuedAction(t.Context(), saved.ID)

	require.NoError(t, err)
	assert.True(t, found)
	got, _ := store.QueuedActions(t.Context())
	assert.Empty(t, got)
}

func TestStore_CancelQueuedAction_UnknownID_ReportsNotFound(t *testing.T) {
	t.Parallel()

	found, err := newTestStore(t).CancelQueuedAction(t.Context(), "nope")

	require.NoError(t, err)
	assert.False(t, found)
}

func TestStore_QueuedActions_SurviveReopeningTheDatabase(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "settings.db")
	open := func() *settings.Store {
		db, err := sql.Open("sqlite", dbdsn.For(path))
		require.NoError(t, err)
		t.Cleanup(func() { _ = db.Close() })
		cipher, err := settings.NewCipher(randomKey(t))
		require.NoError(t, err)
		store := settings.NewStore(db, cipher)
		require.NoError(t, store.Init(t.Context()))

		return store
	}
	saved, _, err := open().EnqueueQueuedAction(t.Context(), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	got, err := open().QueuedActions(t.Context())

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, saved.ID, got[0].ID)
}

func TestStore_HasWaitingQueuedActions(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	none, err := store.HasWaitingQueuedActions(t.Context())
	require.NoError(t, err)
	assert.False(t, none)

	saved, _, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)
	waiting, err := store.HasWaitingQueuedActions(t.Context())
	require.NoError(t, err)
	assert.True(t, waiting)

	saved.Status = dashboard.QueuedDone
	_, err = store.UpdateQueuedAction(t.Context(), saved)
	require.NoError(t, err)
	done, err := store.HasWaitingQueuedActions(t.Context())
	require.NoError(t, err)
	assert.False(t, done)
}

// Retries move RunAt, so the first due time is kept apart from it (#5083).
func TestStore_QueuedActions_KeepWhenTheyFirstCameDue(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	due := time.Date(2026, 10, 11, 14, 32, 0, 0, time.UTC)
	saved, _, err := store.EnqueueQueuedAction(t.Context(), queuedUpdate(due))
	require.NoError(t, err)
	assert.True(t, due.Equal(saved.FirstDueAt), "enqueued %s", saved.FirstDueAt)

	saved.RunAt, saved.FirstDueAt = due.Add(5*time.Minute), due.Add(5*time.Minute)
	_, err = store.UpdateQueuedAction(t.Context(), saved)
	require.NoError(t, err)

	got, err := store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.True(t, due.Equal(got[0].FirstDueAt), "after a reschedule %s", got[0].FirstDueAt)
}

// A database from before the column keeps its waiting actions, and their hour
// starts at the time they are waiting for.
func TestStore_Init_AddsTheFirstDueTimeToAnOlderQueue(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))
	due := time.Date(2026, 10, 11, 14, 32, 0, 0, time.UTC)
	_, _, err = store.EnqueueQueuedAction(t.Context(), queuedUpdate(due))
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `ALTER TABLE queued_actions DROP COLUMN first_due_at`)
	require.NoError(t, err)

	require.NoError(t, store.Init(t.Context()))
	require.NoError(t, store.Init(t.Context()), "every start runs it again")

	got, err := store.QueuedActions(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.True(t, due.Equal(got[0].FirstDueAt), "backfilled %s", got[0].FirstDueAt)
}
