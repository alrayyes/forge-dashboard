package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
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

	saved, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(runAt))
	require.NoError(t, err)

	got, err := store.QueuedActions(t.Context(), []byte("user-1"))
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.NotEmpty(t, saved.ID)
	assert.Equal(t, saved.ID, got[0].ID)
	assert.Equal(t, dashboard.ActionUpdateBranch, got[0].Action)
	assert.Equal(t, dashboard.QueuedWaiting, got[0].Status)
	assert.True(t, runAt.Equal(got[0].RunAt), "runAt %s", got[0].RunAt)
}

func TestStore_EnqueueQueuedAction_SameActionTwice_KeepsTheFirst(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	first, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	second, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(2*time.Hour)))
	require.NoError(t, err)

	assert.Equal(t, first.ID, second.ID)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.Len(t, got, 1)
}

func TestStore_QueuedActions_NoneQueued_ReturnsEmptyNotNil(t *testing.T) {
	t.Parallel()

	got, err := newTestStore(t).QueuedActions(t.Context(), []byte("user-1"))

	require.NoError(t, err)
	assert.NotNil(t, got)
	assert.Empty(t, got)
}

func TestStore_QueuedActions_TwoUsers_EachSeesOnlyTheirOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	got, err := store.QueuedActions(t.Context(), []byte("user-2"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_CancelQueuedAction_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	found, err := store.CancelQueuedAction(t.Context(), []byte("user-1"), saved.ID)

	require.NoError(t, err)
	assert.True(t, found)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.Empty(t, got)
}

func TestStore_CancelQueuedAction_AnotherUsersItem_LeavesItAlone(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	saved, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	found, err := store.CancelQueuedAction(t.Context(), []byte("user-2"), saved.ID)

	require.NoError(t, err)
	assert.False(t, found)
	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.Len(t, got, 1)
}

func TestStore_CancelQueuedAction_UnknownID_ReportsNotFound(t *testing.T) {
	t.Parallel()

	found, err := newTestStore(t).CancelQueuedAction(t.Context(), []byte("user-1"), "nope")

	require.NoError(t, err)
	assert.False(t, found)
}

func TestStore_QueuedActions_SurviveReopeningTheDatabase(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "settings.db")
	open := func() *settings.Store {
		db, err := sql.Open("sqlite", path)
		require.NoError(t, err)
		t.Cleanup(func() { _ = db.Close() })
		cipher, err := settings.NewCipher(randomKey(t))
		require.NoError(t, err)
		store := settings.NewStore(db, cipher)
		require.NoError(t, store.Init(t.Context()))

		return store
	}
	saved, err := open().EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	got, err := open().QueuedActions(t.Context(), []byte("user-1"))

	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, saved.ID, got[0].ID)
}

func TestStore_Delete_RemovesQueuedActions(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	_, err := store.EnqueueQueuedAction(t.Context(), []byte("user-1"), queuedUpdate(time.Now().Add(time.Hour)))
	require.NoError(t, err)

	require.NoError(t, store.Delete(t.Context(), []byte("user-1")))

	got, _ := store.QueuedActions(t.Context(), []byte("user-1"))
	assert.Empty(t, got)
}
