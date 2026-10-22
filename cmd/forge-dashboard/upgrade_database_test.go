package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

const upgradeTestKey = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE="

// seedOldDatabase writes the settings tables the way the release before this one
// left them, with the owner's forge token sealed by the real cipher.
func seedOldDatabase(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	for _, f := range []string{"old_schema.sql", "old_rows.sql"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "internal", "settings", "testdata", f)) //nolint:gosec // G304: a fixed test data name
		require.NoError(t, err)
		_, err = db.ExecContext(t.Context(), string(raw))
		require.NoError(t, err)
	}
	cipher, err := settings.NewCipher(upgradeTestKey)
	require.NoError(t, err)
	seal := func(plain string) string {
		sealed, err := cipher.Encrypt(plain)
		require.NoError(t, err)

		return sealed
	}
	_, err = db.ExecContext(t.Context(), `UPDATE user_credentials SET github_token = ?, forgejo_token = ?`,
		seal("ghp_owner"), seal("fj_owner"))
	require.NoError(t, err)
}

// The migration has to finish before any store creates a table, or Init would
// build the new shape next to the old tables and the copy would find a clash.
func TestOpenUpgradedDatabase_OldDatabase_IsReadableThroughTheStoresAfterwards(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "forge-dashboard.db")
	t.Setenv("DB_PATH", dbPath)
	t.Setenv("ENCRYPTION_KEY", upgradeTestKey)
	seedOldDatabase(t, dbPath)

	db, err := openUpgradedDatabase(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, _, err = buildAuth(t.Context(), db)
	require.NoError(t, err)
	store, err := buildStores(t.Context(), db)
	require.NoError(t, err)

	got, err := store.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "ghp_owner", got.GitHubToken, "the sealed token still opens")
	assert.Equal(t, "fj_owner", got.ForgejoToken)
	assert.Equal(t, "hook-token", got.WebhookToken, "the installed hook keeps its URL")
	assert.Equal(t, "hook-secret", got.WebhookSecret)
	secret, err := store.WebhookSecretFor(t.Context(), "hook-token")
	require.NoError(t, err)
	assert.Equal(t, "hook-secret", secret)
	waiting, err := store.HasWaitingQueuedActions(t.Context())
	require.NoError(t, err)
	assert.True(t, waiting, "the owner's queued action came along")
}

// readTestdata reads a fixture of another package's migration tests.
func readTestdata(t *testing.T, pkg, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "internal", pkg, "testdata", name)) //nolint:gosec // G304: a fixed test data name
	require.NoError(t, err)

	return string(raw)
}

// seedOldAuthAndSettings builds one database the way the release before both
// steps left it: the auth tables with a signed-in session, two API tokens and
// two passkey labels, and the settings tables of the same owner.
func seedOldAuthAndSettings(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", dbdsn.For(path))
	require.NoError(t, err)
	defer func() { _ = db.Close() }()

	// The settings fixture names the owner "owner"; the auth store decodes the
	// id as base64, so it takes the auth fixture's id instead.
	settingsSchema := readTestdata(t, "settings", "old_schema.sql")
	_, settingsSchema, _ = strings.Cut(settingsSchema, "CREATE TABLE users (")
	_, settingsSchema, _ = strings.Cut(settingsSchema, ");")
	settingsRows := readTestdata(t, "settings", "old_rows.sql")
	_, settingsRows, _ = strings.Cut(settingsRows, "\n")
	settingsRows = strings.ReplaceAll(settingsRows, "'owner'", "'b3duZXI'")
	for _, script := range []string{
		readTestdata(t, "auth", "old_schema.sql"), readTestdata(t, "auth", "old_rows.sql"), settingsSchema, settingsRows,
	} {
		_, err = db.ExecContext(t.Context(), script)
		require.NoError(t, err)
	}
	sum := sha256.Sum256([]byte("raw-one"))
	_, err = db.ExecContext(t.Context(), `UPDATE api_tokens SET token_hash = ? WHERE id = 't1'`, hex.EncodeToString(sum[:]))
	require.NoError(t, err)
	cipher, err := settings.NewCipher(upgradeTestKey)
	require.NoError(t, err)
	sealGH, err := cipher.Encrypt("ghp_owner")
	require.NoError(t, err)
	sealFJ, err := cipher.Encrypt("fj_owner")
	require.NoError(t, err)
	_, err = db.ExecContext(t.Context(), `UPDATE user_credentials SET github_token = ?, forgejo_token = ?`, sealGH, sealFJ)
	require.NoError(t, err)
}

// Both steps run in order on one old database, and the owner stays signed in:
// the cookie and a bearer token still authenticate, and the settings come along.
func TestOpenUpgradedDatabase_OldAuthAndSettings_KeepTheOwnerSignedIn(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "forge-dashboard.db")
	t.Setenv("DB_PATH", dbPath)
	t.Setenv("ENCRYPTION_KEY", upgradeTestKey)
	seedOldAuthAndSettings(t, dbPath)

	db, err := openUpgradedDatabase(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, authStore, err := buildAuth(t.Context(), db)
	require.NoError(t, err)
	settingsStore, err := buildStores(t.Context(), db)
	require.NoError(t, err)

	viaCookie, err := authStore.UserForSession(t.Context(), "session-cookie")
	require.NoError(t, err)
	viaToken, err := authStore.UserForAPIToken(t.Context(), "raw-one")
	require.NoError(t, err)
	assert.Equal(t, "ryan", viaCookie.Username)
	assert.Equal(t, viaCookie.ID, viaToken.ID)
	assert.Equal(t, []byte("owner"), viaCookie.ID, "the passkey handle is unchanged")
	tokens, err := authStore.ListAPITokens(t.Context())
	require.NoError(t, err)
	assert.Len(t, tokens, 2)
	got, err := settingsStore.Get(t.Context())
	require.NoError(t, err)
	assert.Equal(t, "ghp_owner", got.GitHubToken)
}

func TestOpenUpgradedDatabase_FreshDatabase_NeedsNoMigration(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "fresh.db"))

	db, err := openUpgradedDatabase(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	var n int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE name LIKE '%\_old' ESCAPE '\'`).Scan(&n))
	assert.Zero(t, n)
}
