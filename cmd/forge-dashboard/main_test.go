package main

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestResolveRefreshInterval_NoEnv_UsesDefault pins the raised default
// (#381): five minutes was sized around polling being the only way an
// update ever arrived, which stopped being true once every tracked repo
// got a real webhook — a reconciliation poll this frequent spends most of
// its GraphQL budget confirming nothing changed.
func TestResolveRefreshInterval_NoEnv_UsesDefault(t *testing.T) {
	got := resolveRefreshInterval("")
	assert.Equal(t, defaultRefreshInterval, got)
}

func TestResolveRefreshInterval_ValidEnv_Overrides(t *testing.T) {
	got := resolveRefreshInterval("2m30s")
	assert.Equal(t, 2*time.Minute+30*time.Second, got)
}

func TestResolveRefreshInterval_InvalidEnv_FallsBackToDefault(t *testing.T) {
	got := resolveRefreshInterval("not-a-duration")
	assert.Equal(t, defaultRefreshInterval, got)
}

// TestOpenDatabase_SurvivesConcurrentWriters is a regression test for
// forge-dashboard#82: without a busy_timeout, SQLite fails a write
// immediately with SQLITE_BUSY the moment another connection holds the
// write lock, instead of waiting for it — and database/sql routinely
// hands out more than one connection to concurrent goroutines.
func TestOpenDatabase_SurvivesConcurrentWriters(t *testing.T) {
	t.Setenv("DB_PATH", filepath.Join(t.TempDir(), "concurrency.db"))

	db, err := openDatabase()
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.ExecContext(t.Context(), `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`)
	require.NoError(t, err)

	const writers = 40
	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := db.ExecContext(t.Context(), `INSERT INTO t (v) VALUES (?)`, fmt.Sprintf("row-%d", i))
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		assert.NoError(t, err)
	}

	var count int
	require.NoError(t, db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM t`).Scan(&count))
	assert.Equal(t, writers, count)
}

// TestConfigureLogging_DebugLevel_EnablesDebugLogging is a regression test
// for a real incident: diagnosing a rate-limit burst needed to know the
// exact request volume it produced, and the process had no way to log at
// that detail at all. Not run in parallel — configureLogging mutates the
// global default logger, same as every other test in this package
// touching shared process state.
func TestConfigureLogging_DebugLevel_EnablesDebugLogging(t *testing.T) {
	t.Setenv("LOG_LEVEL", "debug")
	configureLogging()

	assert.True(t, slog.Default().Enabled(t.Context(), slog.LevelDebug))
}

func TestConfigureLogging_NoLevelSet_DebugStaysDisabled(t *testing.T) {
	t.Setenv("LOG_LEVEL", "")
	configureLogging()

	assert.False(t, slog.Default().Enabled(t.Context(), slog.LevelDebug))
	assert.True(t, slog.Default().Enabled(t.Context(), slog.LevelInfo))
}
