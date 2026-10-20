package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// One pull request's own choice about automatic branch updates, which
// overrides its repo's setting only while it differs from it.

func TestStore_SetPullRequestAutoUpdate_ThenOverrides_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{settings.AutoMergeKey("github", "alrayyes/a", 7): false}, got)
}

func TestStore_PullRequestAutoUpdates_NoneSet_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.PullRequestAutoUpdates(t.Context(), []byte("user-1"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_SetPullRequestAutoUpdate_RepeatCall_ReplacesTheEarlierChoice(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, true))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)

	require.NoError(t, err)
	assert.Equal(t, map[string]bool{settings.AutoMergeKey("github", "alrayyes/a", 7): true}, got)
}

func TestStore_ClearPullRequestAutoUpdate_RemovesTheOverride_AndIsIdempotent(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))

	require.NoError(t, store.ClearPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7))
	require.NoError(t, store.ClearPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_PullRequestAutoUpdates_AreKeptPerUser(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), []byte("user-1"), "github", "alrayyes/a", 7, false))

	got, err := store.PullRequestAutoUpdates(t.Context(), []byte("user-2"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_ForgetPullRequestAutoUpdates_DropsOnlyTheNamedOnes(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 8, true))

	require.NoError(t, store.ForgetPullRequestAutoUpdates(t.Context(), userID, []settings.PullRequestRef{{Forge: "github", Repo: "alrayyes/a", Number: 7}}))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, map[string]bool{settings.AutoMergeKey("github", "alrayyes/a", 8): true}, got)
}

func TestParseAutoMergeKey_ReadsBackWhatAutoMergeKeyBuilt(t *testing.T) {
	t.Parallel()

	got, ok := settings.ParseAutoMergeKey(settings.AutoMergeKey("forgejo", "team/some-repo", 42))

	require.True(t, ok)
	assert.Equal(t, settings.PullRequestRef{Forge: "forgejo", Repo: "team/some-repo", Number: 42}, got)
}

func TestParseAutoMergeKey_SomethingElse_IsNotAKey(t *testing.T) {
	t.Parallel()

	for _, key := range []string{"", "github", "github/owner/repo", "github/owner/repo#x"} {
		_, ok := settings.ParseAutoMergeKey(key)
		assert.False(t, ok, key)
	}
}

func TestStore_Delete_RemovesThePullRequestAutoUpdates(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.SetPullRequestAutoUpdate(t.Context(), userID, "github", "alrayyes/a", 7, false))

	require.NoError(t, store.Delete(t.Context(), userID))

	got, err := store.PullRequestAutoUpdates(t.Context(), userID)
	require.NoError(t, err)
	assert.Empty(t, got)
}
