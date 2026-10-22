package dbdsn_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// The modernc driver does not stop a busy wait when the request's context is
// cancelled: the wait runs out the busy timeout. The comment on
// requestlog.Writer and docs/running.md say so, so this test fails when a
// driver upgrade changes it and those need rewording.
func TestBusyWait_IgnoresAContextCancelledMeanwhile(t *testing.T) {
	t.Parallel()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db")+"?_busy_timeout=1500&_journal_mode=WAL")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.Exec(`CREATE TABLE t (n INTEGER)`)
	require.NoError(t, err)

	// Hold the write lock on its own connection for the whole test.
	holder, err := db.Conn(context.Background())
	require.NoError(t, err)
	t.Cleanup(func() { _ = holder.Close() })
	_, err = holder.ExecContext(context.Background(), `BEGIN IMMEDIATE`)
	require.NoError(t, err)

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err = db.ExecContext(ctx, `INSERT INTO t VALUES (1)`)
	waited := time.Since(start)

	require.Error(t, err)
	require.GreaterOrEqual(t, waited, time.Second, "the wait ran on past the cancel, to the busy timeout")
}
