package main

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
