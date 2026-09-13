package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func newTestStore(t *testing.T) *settings.Store {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "settings.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))
	return store
}

func TestStore_SetThenGet_RoundTrips(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	want := settings.Credentials{
		GitHubToken:     "ghp_abc123",
		GitHubUsername:  "ryan",
		ForgejoURL:      "https://git.example.com",
		ForgejoToken:    "fj_xyz789",
		ForgejoUsername: "ryan",
	}
	require.NoError(t, store.Set(t.Context(), userID, want))

	got, err := store.Get(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, want.GitHubToken, got.GitHubToken)
	assert.Equal(t, want.GitHubUsername, got.GitHubUsername)
	assert.Equal(t, want.ForgejoURL, got.ForgejoURL)
	assert.Equal(t, want.ForgejoToken, got.ForgejoToken)
	assert.Equal(t, want.ForgejoUsername, got.ForgejoUsername)
	assert.False(t, got.UpdatedAt.IsZero())
}

func TestStore_Get_NeverSaved_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, err := store.Get(t.Context(), []byte("nobody"))

	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_Set_Twice_ReplacesTheWholeRow(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubToken: "first-token"}))
	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubToken: "second-token"}))

	got, err := store.Get(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, "second-token", got.GitHubToken)
}

func TestStore_Delete_ThenGet_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubToken: "a-token"}))
	require.NoError(t, store.Delete(t.Context(), userID))

	_, err := store.Get(t.Context(), userID)
	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_Delete_NeverSaved_IsANoOp(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	assert.NoError(t, store.Delete(t.Context(), []byte("nobody")))
}

func TestStore_TokensAreEncryptedAtRest(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "settings.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)
	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	userID := []byte("user-1")
	const secretToken = "ghp_this-must-never-appear-in-plaintext" // #nosec G101 -- a fake test fixture, not a real credential
	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubToken: secretToken}))

	// Queried by scanning the one row that exists rather than
	// reconstructing the store's own user-id encoding here — this test
	// only cares what's in the column, not how the row is addressed.
	var rawColumn string
	require.NoError(t, db.QueryRow(`SELECT github_token FROM user_credentials LIMIT 1`).Scan(&rawColumn))
	assert.NotContains(t, rawColumn, secretToken, "the raw database column must never hold the plaintext token")
	assert.NotEmpty(t, rawColumn)
}
