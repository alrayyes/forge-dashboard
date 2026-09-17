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

func TestStore_SetThenGet_RoundTripsAllowBotPrUpdatesAndRenovateRebaseLabel(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	want := settings.Credentials{
		AllowBotPrUpdates:   true,
		RenovateRebaseLabel: "retry",
	}
	require.NoError(t, store.Set(t.Context(), userID, want))

	got, err := store.Get(t.Context(), userID)
	require.NoError(t, err)
	assert.True(t, got.AllowBotPrUpdates)
	assert.Equal(t, "retry", got.RenovateRebaseLabel)
}

func TestCredentials_RenovateRebaseLabelOrDefault_EmptyFallsBackToRenovatesOwnDefault(t *testing.T) {
	t.Parallel()
	c := settings.Credentials{}
	assert.Equal(t, "rebase", c.RenovateRebaseLabelOrDefault())
}

func TestCredentials_RenovateRebaseLabelOrDefault_UsesSavedValueWhenSet(t *testing.T) {
	t.Parallel()
	c := settings.Credentials{RenovateRebaseLabel: "needs-rebase"}
	assert.Equal(t, "needs-rebase", c.RenovateRebaseLabelOrDefault())
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

func TestStore_EnsureWebhookCredentials_FirstCall_GeneratesNonEmptyValues(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	token, secret, err := store.EnsureWebhookCredentials(t.Context(), userID)

	require.NoError(t, err)
	assert.NotEmpty(t, token)
	assert.NotEmpty(t, secret)
	assert.NotEqual(t, token, secret, "the URL-facing token and the HMAC-signing secret must be two different values")
}

func TestStore_EnsureWebhookCredentials_SecondCall_ReturnsTheSameValues(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	firstToken, firstSecret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	secondToken, secondSecret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	assert.Equal(t, firstToken, secondToken, "a webhook already configured on a forge points at this URL — it can't change on every visit to Settings")
	assert.Equal(t, firstSecret, secondSecret)
}

func TestStore_EnsureWebhookCredentials_TwoUsers_GetDifferentValues(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	tokenA, secretA, err := store.EnsureWebhookCredentials(t.Context(), []byte("user-a"))
	require.NoError(t, err)
	tokenB, secretB, err := store.EnsureWebhookCredentials(t.Context(), []byte("user-b"))
	require.NoError(t, err)

	assert.NotEqual(t, tokenA, tokenB)
	assert.NotEqual(t, secretA, secretB)
}

func TestStore_EnsureWebhookCredentials_AfterExistingSettingsSaved_LeavesThemIntact(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubToken: "ghp_existing", GitHubUsername: "ryan"}))

	_, _, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	got, err := store.Get(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, "ghp_existing", got.GitHubToken, "generating webhook credentials must not disturb settings already saved")
	assert.Equal(t, "ryan", got.GitHubUsername)
}

func TestStore_Set_NeverOverwritesAlreadyGeneratedWebhookCredentials(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	token, secret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	// A real settings save (the Settings page's own Save button) — it
	// doesn't know about webhook credentials at all, and shouldn't need
	// to for them to survive.
	require.NoError(t, store.Set(t.Context(), userID, settings.Credentials{GitHubUsername: "octocat"}))

	gotToken, gotSecret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, token, gotToken)
	assert.Equal(t, secret, gotSecret)
}

func TestStore_Get_IncludesWebhookCredentialsOnceGenerated(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	token, secret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	got, err := store.Get(t.Context(), userID)
	require.NoError(t, err)
	assert.Equal(t, token, got.WebhookToken)
	assert.Equal(t, secret, got.WebhookSecret)
}

func TestStore_FindByWebhookToken_ReturnsTheOwningUserAndSecret(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	token, secret, err := store.EnsureWebhookCredentials(t.Context(), userID)
	require.NoError(t, err)

	gotUserID, gotSecret, err := store.FindByWebhookToken(t.Context(), token)
	require.NoError(t, err)
	assert.Equal(t, userID, gotUserID)
	assert.Equal(t, secret, gotSecret)
}

func TestStore_FindByWebhookToken_UnknownToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	_, _, err := store.FindByWebhookToken(t.Context(), "not-a-real-token")

	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_FindByWebhookToken_EmptyToken_ReturnsErrNotFound(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	// Every row that's never called EnsureWebhookCredentials shares ""
	// as its webhook_token default — this must never resolve to one of
	// them, or an empty token in a request would pick an arbitrary user.
	require.NoError(t, store.Set(t.Context(), []byte("user-1"), settings.Credentials{GitHubUsername: "ryan"}))
	require.NoError(t, store.Set(t.Context(), []byte("user-2"), settings.Credentials{GitHubUsername: "octocat"}))

	_, _, err := store.FindByWebhookToken(t.Context(), "")

	assert.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_FindByWebhookToken_TwoUsers_EachResolvesToTheirOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	tokenA, secretA, err := store.EnsureWebhookCredentials(t.Context(), []byte("user-a"))
	require.NoError(t, err)
	tokenB, secretB, err := store.EnsureWebhookCredentials(t.Context(), []byte("user-b"))
	require.NoError(t, err)

	gotUserIDA, gotSecretA, err := store.FindByWebhookToken(t.Context(), tokenA)
	require.NoError(t, err)
	assert.Equal(t, []byte("user-a"), gotUserIDA)
	assert.Equal(t, secretA, gotSecretA)

	gotUserIDB, gotSecretB, err := store.FindByWebhookToken(t.Context(), tokenB)
	require.NoError(t, err)
	assert.Equal(t, []byte("user-b"), gotUserIDB)
	assert.Equal(t, secretB, gotSecretB)
}

func TestStore_WebhookDeliveries_NeverRecorded_ReturnsEmpty(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	got, err := store.WebhookDeliveries(t.Context(), []byte("user-1"))

	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_RecordWebhookDelivery_ThenWebhookDeliveries_ReturnsIt(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")

	require.NoError(t, store.RecordWebhookDelivery(t.Context(), userID, "github", "alrayyes/forge-dashboard"))

	got, err := store.WebhookDeliveries(t.Context(), userID)
	require.NoError(t, err)
	assert.Contains(t, got, settings.WebhookDeliveryKey("github", "alrayyes/forge-dashboard"))
}

func TestStore_RecordWebhookDelivery_TwoUsers_EachSeesOnlyTheirOwn(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)

	require.NoError(t, store.RecordWebhookDelivery(t.Context(), []byte("user-a"), "github", "alrayyes/forge-dashboard"))

	got, err := store.WebhookDeliveries(t.Context(), []byte("user-b"))
	require.NoError(t, err)
	assert.Empty(t, got)
}

func TestStore_Delete_RemovesWebhookDeliveries(t *testing.T) {
	t.Parallel()
	store := newTestStore(t)
	userID := []byte("user-1")
	require.NoError(t, store.RecordWebhookDelivery(t.Context(), userID, "github", "alrayyes/forge-dashboard"))

	require.NoError(t, store.Delete(t.Context(), userID))

	got, err := store.WebhookDeliveries(t.Context(), userID)
	require.NoError(t, err)
	assert.Empty(t, got)
}
