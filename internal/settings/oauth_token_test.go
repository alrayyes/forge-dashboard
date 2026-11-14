package settings_test

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
	_ "modernc.org/sqlite"
)

func newTokenStore(t *testing.T) (*settings.Store, *sql.DB) {
	t.Helper()

	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "settings.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := settings.NewCipher(randomKey(t))
	require.NoError(t, err)

	store := settings.NewStore(db, cipher)
	require.NoError(t, store.Init(t.Context()))

	return store, db
}

func sampleToken() *oauth2.Token {
	return &oauth2.Token{
		AccessToken:  "access-secret-1",
		RefreshToken: "refresh-secret-1",
		TokenType:    "bearer",
		Expiry:       time.Date(2026, 11, 14, 13, 0, 0, 0, time.UTC),
	}
}

func TestStore_OAuthToken_RoundTrips(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveOAuthToken(t.Context(), "forgejo", sampleToken()))

	got, err := store.OAuthToken(t.Context(), "forgejo")
	require.NoError(t, err)

	t.Run("access token", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "access-secret-1", got.AccessToken)
	})

	t.Run("refresh token", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "refresh-secret-1", got.RefreshToken)
	})

	t.Run("expiry", func(t *testing.T) {
		t.Parallel()
		assert.True(t, sampleToken().Expiry.Equal(got.Expiry))
	})
}

func TestStore_OAuthToken_NeverLinked_IsNotFound(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)

	_, err := store.OAuthToken(t.Context(), "github")

	require.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_OAuthToken_KeepsEachForgeApart(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveOAuthToken(t.Context(), "forgejo", sampleToken()))

	_, err := store.OAuthToken(t.Context(), "github")

	require.ErrorIs(t, err, settings.ErrNotFound)
}

func TestStore_OAuthToken_SavingAgainReplacesThePair(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveOAuthToken(t.Context(), "github", sampleToken()))

	rotated := sampleToken()
	rotated.AccessToken, rotated.RefreshToken = "access-secret-2", "refresh-secret-2"
	require.NoError(t, store.SaveOAuthToken(t.Context(), "github", rotated))

	got, err := store.OAuthToken(t.Context(), "github")
	require.NoError(t, err)
	assert.Equal(t, "refresh-secret-2", got.RefreshToken)
}

func TestStore_OAuthToken_IsEncryptedAtRest(t *testing.T) {
	t.Parallel()

	store, db := newTokenStore(t)
	require.NoError(t, store.SaveOAuthToken(t.Context(), "forgejo", sampleToken()))

	var stored string
	require.NoError(t, db.QueryRowContext(t.Context(),
		`SELECT token FROM oauth_tokens WHERE forge = 'forgejo'`).Scan(&stored))

	for _, secret := range []string{"access-secret-1", "refresh-secret-1"} {
		t.Run(secret, func(t *testing.T) {
			t.Parallel()
			assert.NotContains(t, stored, secret)
		})
	}
}

func TestStore_DeleteOAuthToken_UnlinksTheForge(t *testing.T) {
	t.Parallel()

	store, _ := newTokenStore(t)
	require.NoError(t, store.SaveOAuthToken(t.Context(), "forgejo", sampleToken()))
	require.NoError(t, store.DeleteOAuthToken(t.Context(), "forgejo"))

	_, err := store.OAuthToken(t.Context(), "forgejo")

	require.ErrorIs(t, err, settings.ErrNotFound)
}
