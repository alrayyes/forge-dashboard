package settings_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// One pull request a user hid (#841): out of the board until restored, or
// until a time they chose.

func TestStore_HidePullRequest_ThenHiddenPullRequests_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())
	require.NoError(t, err)
	assert.Contains(t, got, settings.AutoMergeKey("github", "alrayyes/a", 7))
}

func TestStore_HiddenPullRequests_NoneHidden_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.HiddenPullRequests(t.Context(), []byte("user-1"), time.Now())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_HidePullRequest_WithoutAnEndTime_NeverExpires(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now().AddDate(10, 0, 0))

	require.NoError(t, err)
	assert.Len(t, got, 1)
}

func TestStore_HidePullRequest_ReportsItsEndTime(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	until := time.Now().Add(7 * 24 * time.Hour).UTC().Truncate(time.Second)
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, until))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())

	require.NoError(t, err)
	assert.True(t, until.Equal(got[settings.AutoMergeKey("github", "alrayyes/a", 7)].Until))
}

func TestStore_HiddenPullRequests_DropsOneWhoseTimeHasPassed(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	until := time.Now().Add(time.Hour)
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, until))

	got, err := store.HiddenPullRequests(t.Context(), userID, until.Add(time.Second))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_HiddenPullRequests_ForgetsAnExpiredOneForGood(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	until := time.Now().Add(time.Hour)
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, until))
	_, err := store.HiddenPullRequests(t.Context(), userID, until.Add(time.Second))
	require.NoError(t, err)

	// Asked again with an earlier clock, it is still gone: the row was deleted.
	got, err := store.HiddenPullRequests(t.Context(), userID, until.Add(-time.Minute))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_HidePullRequest_Twice_ReplacesTheEarlierChoice(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))
	until := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, until))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())

	require.NoError(t, err)
	assert.True(t, until.Equal(got[settings.AutoMergeKey("github", "alrayyes/a", 7)].Until))
}

func TestStore_UnhidePullRequest_RemovesIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))

	require.NoError(t, store.UnhidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_UnhidePullRequest_NotHidden_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	assert.NoError(t, store.UnhidePullRequest(t.Context(), []byte("user-1"), "github", "alrayyes/a", 7))
}

func TestStore_HidePullRequest_KeepsTwoPullRequestsOfOneRepoApart(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 8, time.Time{}))

	require.NoError(t, store.UnhidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())
	require.NoError(t, err)
	assert.Contains(t, got, settings.AutoMergeKey("github", "alrayyes/a", 8))
}

func TestStore_HiddenPullRequests_AreEachUsersOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	require.NoError(t, store.HidePullRequest(t.Context(), []byte("user-1"), "github", "alrayyes/a", 7, time.Time{}))

	got, err := store.HiddenPullRequests(t.Context(), []byte("user-2"), time.Now())

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_ForgetHiddenPullRequests_RemovesOnlyTheOnesNamed(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 8, time.Time{}))

	require.NoError(t, store.ForgetHiddenPullRequests(t.Context(), userID, []settings.HiddenPullRequest{{Forge: "github", Repo: "alrayyes/a", Number: 7}}))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())
	require.NoError(t, err)
	assert.Len(t, got, 1)
}

func TestStore_Delete_RemovesTheUsersHiddenPullRequests(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.HidePullRequest(t.Context(), userID, "github", "alrayyes/a", 7, time.Time{}))

	require.NoError(t, store.Delete(t.Context(), userID))

	got, err := store.HiddenPullRequests(t.Context(), userID, time.Now())
	require.NoError(t, err)
	assert.Empty(t, got)
}
