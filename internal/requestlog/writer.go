package requestlog

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
)

// RowStore is what the Writer persists rows into. *auth.Store satisfies it.
type RowStore interface {
	RecordRequest(ctx context.Context, row auth.RequestLogRow, maxEntries int) error
}

// Writer is the one place request-log rows are written from (#902). Each
// outbound forge request used to write its own row inline, so a locked
// database left one goroutine, and one OS thread, waiting per request for
// the whole busy timeout (set in internal/dbdsn). Cancelling the request's
// context does not shorten that wait: the modernc driver ignores it while
// SQLite waits on the lock. Now callers enqueue and move on; a single
// goroutine does the writing, and a full queue drops the row and counts it
// rather than blocking a request.
type Writer struct {
	store   RowStore
	queue   chan auth.RequestLogRow
	dropped atomic.Int64
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

// NewWriter starts a Writer with room for size queued rows.
func NewWriter(store RowStore, size int) *Writer {
	w := &Writer{store: store, queue: make(chan auth.RequestLogRow, size), stop: make(chan struct{}), done: make(chan struct{})}
	go w.run()

	return w
}

func (w *Writer) run() {
	defer close(w.done)
	for {
		select {
		case row := <-w.queue:
			w.write(row)
		case <-w.stop:
			for {
				select {
				case row := <-w.queue:
					w.write(row)
				default:
					return
				}
			}
		}
	}
}

func (w *Writer) write(row auth.RequestLogRow) {
	if err := w.store.RecordRequest(context.Background(), row, MaxEntries); err != nil {
		slog.Warn("request log: write failed", "error", err)
	}
}

// submit enqueues row without ever blocking.
func (w *Writer) submit(row auth.RequestLogRow) {
	select {
	case w.queue <- row:
	default:
		if n := w.dropped.Add(1); n == 1 || n%100 == 0 {
			slog.Warn("request log: queue full, dropping rows", "dropped", n)
		}
	}
}

// Dropped is how many rows a full queue has discarded so far.
func (w *Writer) Dropped() int64 { return w.dropped.Load() }

// Close writes what's queued, then stops. A row submitted afterwards is
// never written, but never blocks or panics either.
func (w *Writer) Close() {
	w.once.Do(func() { close(w.stop) })
	<-w.done
}

// CloseWithin is Close that gives up after limit, so a locked database can't
// hold a shutdown past its grace period: each queued row would otherwise wait
// out the busy timeout in turn. It reports whether the queue was flushed. A
// row still queued when it gives up is lost, like one dropped by a full queue.
func (w *Writer) CloseWithin(limit time.Duration) bool {
	w.once.Do(func() { close(w.stop) })

	timer := time.NewTimer(limit)
	defer timer.Stop()

	select {
	case <-w.done:
		return true
	case <-timer.C:
		return false
	}
}
