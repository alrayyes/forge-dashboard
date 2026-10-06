package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_ArmAutoMerge_ThenAutoMergeIntents_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	got, err := store.AutoMergeIntents(t.Context(), userID)
	require.NoError(t, err)
	assert.Contains(t, got, settings.AutoMergeKey("forgejo", "alrayyes/a", 7))
}

func TestStore_AutoMergeIntents_NoneArmed_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.AutoMergeIntents(t.Context(), []byte("user-1"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_ArmAutoMerge_Twice_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))
	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	got, err := store.AutoMergeIntents(t.Context(), userID)
	require.NoError(t, err)
	assert.Len(t, got, 1)
}

func TestStore_ArmAutoMerge_KeepsTwoPullRequestsOfOneRepoApart(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	got, err := store.AutoMergeIntents(t.Context(), userID)
	require.NoError(t, err)
	assert.NotContains(t, got, settings.AutoMergeKey("forgejo", "alrayyes/a", 8))
}

func TestStore_CancelAutoMerge_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	require.NoError(t, store.CancelAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	got, err := store.AutoMergeIntents(t.Context(), userID)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_CancelAutoMerge_NeverArmed_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	err := store.CancelAutoMerge(t.Context(), []byte("user-1"), "forgejo", "alrayyes/a", 7)

	require.NoError(t, err)
}

func TestStore_ArmAutoMerge_TwoUsers_EachSeesOnlyTheirOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.ArmAutoMerge(t.Context(), []byte("user-a"), "forgejo", "alrayyes/a", 7))

	got, err := store.AutoMergeIntents(t.Context(), []byte("user-b"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_Delete_RemovesAutoMergeIntents(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.ArmAutoMerge(t.Context(), userID, "forgejo", "alrayyes/a", 7))

	require.NoError(t, store.Delete(t.Context(), userID))

	got, err := store.AutoMergeIntents(t.Context(), userID)
	require.NoError(t, err)
	assert.Empty(t, got)
}
