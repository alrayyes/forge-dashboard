package requestlog_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/requestlog"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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
