package main

import (
	"database/sql"
	"os"
	"path/filepath"
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

func TestOpenUpgradedDatabase_FreshDatabase_NeedsNoMigration(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "fresh.db"))

	db, err := openUpgradedDatabase(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	var n int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE name LIKE '%\_old' ESCAPE '\'`).Scan(&n))
	assert.Zero(t, n)
}
