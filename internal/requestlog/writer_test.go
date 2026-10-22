package requestlog_test

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

// gatedStore holds every write until release is closed, standing in for a
// locked database.
type gatedStore struct {
	release chan struct{}
	mu      sync.Mutex
	rows    []auth.RequestLogRow
}

func (g *gatedStore) RecordRequest(_ context.Context, row auth.RequestLogRow, _ int) error {
	<-g.release
	g.mu.Lock()
	g.rows = append(g.rows, row)
	g.mu.Unlock()

	return nil
}

func (g *gatedStore) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()

	return len(g.rows)
}

func TestWriter_FullQueueDropsTheRowAndNeverBlocksTheCaller(t *testing.T) {
	t.Parallel()
	store := &gatedStore{release: make(chan struct{})}
	w := requestlog.NewWriter(store, 2)
	rec := requestlog.NewSQLiteRecorder(nil, "acct", requestlog.WithWriter(w))

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 20 {
			assert.NoError(t, rec.Record(t.Context(), requestlog.Entry{Forge: dashboard.ForgeGitHub, Outcome: requestlog.OutcomeSuccess}))
		}
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Record blocked on a stuck database")
	}
	// The writer holds one row and the queue two; the rest are dropped. The
	// writer may not have taken its first row yet, so one more can drop.
	dropped := w.Dropped()
	assert.GreaterOrEqual(t, dropped, int64(17))

	close(store.release)
	w.Close()
	assert.Equal(t, 20, store.count()+int(dropped))
}

func TestWriter_CloseDrainsWhatIsQueued(t *testing.T) {
	t.Parallel()
	store := &gatedStore{release: make(chan struct{})}
	close(store.release)
	w := requestlog.NewWriter(store, 8)
	rec := requestlog.NewSQLiteRecorder(nil, "acct", requestlog.WithWriter(w))

	for range 5 {
		require.NoError(t, rec.Record(t.Context(), requestlog.Entry{Outcome: requestlog.OutcomeSuccess}))
	}
	w.Close()

	assert.Equal(t, 5, store.count())
	assert.Zero(t, w.Dropped())
}

// lockedStore writes through a real SQLite connection while another holds the
// write lock, so RecordRequest really waits out the busy timeout.
type lockedStore struct{ db *sql.DB }

func (l lockedStore) RecordRequest(ctx context.Context, _ auth.RequestLogRow, _ int) error {
	if _, err := l.db.ExecContext(ctx, `INSERT INTO t VALUES (1)`); err != nil {
		return fmt.Errorf("insert: %w", err)
	}

	return nil
}

func TestWriter_CloseWithin_GivesUpOnADatabaseLockedPastTheLimit(t *testing.T) {
	t.Parallel()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db")+"?_busy_timeout=3000&_journal_mode=WAL")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE t (n INTEGER)`)
	require.NoError(t, err)
	holder, err := db.Conn(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = holder.Close() })
	_, err = holder.ExecContext(t.Context(), `BEGIN IMMEDIATE`)
	require.NoError(t, err)

	w := requestlog.NewWriter(lockedStore{db: db}, 8)
	rec := requestlog.NewSQLiteRecorder(nil, "acct", requestlog.WithWriter(w))
	for range 3 {
		require.NoError(t, rec.Record(t.Context(), requestlog.Entry{Outcome: requestlog.OutcomeSuccess}))
	}

	start := time.Now()
	flushed := w.CloseWithin(200 * time.Millisecond)

	assert.False(t, flushed, "the queue could not drain while the lock was held")
	assert.Less(t, time.Since(start), time.Second, "Close must not sit out the busy timeout")
}

func TestWriter_CloseWithin_ReportsAFlushThatFinishedInTime(t *testing.T) {
	t.Parallel()
	store := &gatedStore{release: make(chan struct{})}
	close(store.release)
	w := requestlog.NewWriter(store, 8)

	assert.True(t, w.CloseWithin(time.Second))
}

// A handler cut by srv.Close can still log after the flush has started or given
// up. That write must neither panic nor block, and is never stored.
func TestWriter_ARowSubmittedAfterCloseWithinNeitherPanicsNorBlocks(t *testing.T) {
	t.Parallel()
	store := &gatedStore{release: make(chan struct{})}
	w := requestlog.NewWriter(store, 1)
	rec := requestlog.NewSQLiteRecorder(nil, "acct", requestlog.WithWriter(w))
	require.NoError(t, rec.Record(t.Context(), requestlog.Entry{Outcome: requestlog.OutcomeSuccess}))

	require.False(t, w.CloseWithin(50*time.Millisecond), "the held write keeps the flush from finishing")

	late := make(chan error, 1)
	go func() {
		var err error
		for range 3 { // past the queue size, so the full-queue path runs too
			err = rec.Record(t.Context(), requestlog.Entry{Outcome: requestlog.OutcomeSuccess})
		}
		late <- err
	}()

	select {
	case err := <-late:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("a late write blocked")
	}

	close(store.release)
	w.Close()
	assert.LessOrEqual(t, store.count(), 2, "rows submitted after the close began are not all written")
}
