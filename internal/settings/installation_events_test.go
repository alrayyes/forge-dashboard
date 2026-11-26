package settings_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore_RemoveInstallation_DropsTheRowAndKeepsTheOthers(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 1, AccountLogin: "a"}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 2, AccountLogin: "b"}))

	require.NoError(t, store.RemoveInstallation(t.Context(), 1))

	got, err := store.Installations(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, int64(2), got[0].ID)
}

func TestStore_RemoveInstallation_TheSavedLegacyID_IsNotReadAgain(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 9}))

	require.NoError(t, store.RemoveInstallation(t.Context(), 9))

	c, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Zero(t, c.GitHubAppInstallationID)
	assert.Empty(t, c.GitHubAppInstallationIDs)
}

func TestStore_SetInstallationSuspended_DisablesReadsUntilItIsLifted(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 9}))
	require.NoError(t, store.SaveInstallation(t.Context(), settings.Installation{ID: 5, AccountLogin: "alice"}))

	require.NoError(t, store.SetInstallationSuspended(t.Context(), 9, true))

	got, err := store.Installations(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 2)
	assert.False(t, got[0].Enabled)
	assert.Equal(t, settings.InstallationSuspended, got[0].Status)
	c, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, []int64{5}, c.GitHubAppInstallationIDs)

	require.NoError(t, store.SetInstallationSuspended(t.Context(), 9, false))

	got, err = store.Installations(t.Context())
	require.NoError(t, err)
	assert.True(t, got[0].Enabled)
	assert.Equal(t, settings.InstallationConnected, got[0].Status)
}

func TestStore_SetInstallationSuspended_TheOnlyOne_LeavesNothingToRead(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.Set(t.Context(), settings.Credentials{GitHubAppInstallationID: 9}))

	require.NoError(t, store.SetInstallationSuspended(t.Context(), 9, true))

	c, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Empty(t, c.GitHubAppInstallationIDs, "the saved column must not bring a suspended installation back")
}

func TestStore_SetInstallationSuspended_UnknownID_ChangesNothing(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)

	require.NoError(t, store.SetInstallationSuspended(t.Context(), 404, true))

	got, err := store.Installations(t.Context())
	require.NoError(t, err)
	assert.Empty(t, got)
}
