package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func TestDropLegacyShares_LeftoverTable_IsDropped(t *testing.T) {
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "legacy.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.ExecContext(t.Context(), `CREATE TABLE shares (owner_id TEXT NOT NULL, viewer_id TEXT NOT NULL)`)
	require.NoError(t, err)

	require.NoError(t, dropLegacyShares(t.Context(), db))

	var n int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE name = 'shares'`).Scan(&n))
	assert.Zero(t, n)
}

func TestDropLegacyShares_NoTable_IsANoOp(t *testing.T) {
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "fresh.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	require.NoError(t, dropLegacyShares(t.Context(), db))
}

func TestBuildStores_LeftoverSharesTable_IsDroppedAtStartup(t *testing.T) {
	t.Setenv("ENCRYPTION_KEY", "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=")
	db, err := sql.Open("sqlite", dbdsn.For(filepath.Join(t.TempDir(), "startup.db")))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.ExecContext(t.Context(), `CREATE TABLE shares (owner_id TEXT NOT NULL, viewer_id TEXT NOT NULL)`)
	require.NoError(t, err)

	_, err = buildStores(t.Context(), db)
	require.NoError(t, err)

	var n int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT count(*) FROM sqlite_master WHERE name = 'shares'`).Scan(&n))
	assert.Zero(t, n)
}
