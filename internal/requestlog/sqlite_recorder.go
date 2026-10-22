package requestlog

import (
	"context"
	"fmt"

	"github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// SQLiteRecorder is the concrete Recorder every forge client is wired up
// with — it persists into internal/auth.Store's own request_log table
// (the same SQLite database auth/session data already lives in, per
// design.md's "reuse what's already there" decision) rather than
// standing up a second storage mechanism for one more record type.
type SQLiteRecorder struct {
	store  *auth.Store
	writer *Writer
}

// Option configures a SQLiteRecorder.
type Option func(*SQLiteRecorder)

// WithWriter sends Record's rows through w's bounded queue and single
// writer instead of writing inline (#902). Record then never waits on the
// database and never fails; a full queue drops the row and counts it.
func WithWriter(w *Writer) Option {
	return func(r *SQLiteRecorder) { r.writer = w }
}

// NewSQLiteRecorder returns a SQLiteRecorder that persists into store.
func NewSQLiteRecorder(store *auth.Store, opts ...Option) *SQLiteRecorder {
	r := &SQLiteRecorder{store: store}
	for _, opt := range opts {
		opt(r)
	}

	return r
}

var _ Recorder = (*SQLiteRecorder)(nil)

// Record implements Recorder.
func (r *SQLiteRecorder) Record(ctx context.Context, e Entry) error {
	row := auth.RequestLogRow{
		LoggedAt:           e.LoggedAt,
		Forge:              string(e.Forge),
		Method:             e.Method,
		Endpoint:           e.Endpoint,
		StatusCode:         e.StatusCode,
		Outcome:            e.Outcome,
		RateLimitLimit:     e.RateLimitLimit,
		RateLimitRemaining: e.RateLimitRemaining,
		RateLimitResetsAt:  e.RateLimitResetsAt,
		RateLimitCost:      e.RateLimitCost,
	}
	if r.writer != nil {
		r.writer.submit(row)

		return nil
	}
	if err := r.store.RecordRequest(ctx, row, MaxEntries); err != nil {
		return fmt.Errorf("requestlog: record: %w", err)
	}

	return nil
}

// List returns every entry matching filter, newest first — the read
// path of the request-log handlers in internal/api, kept on this same type
// rather than a second one, since it's just RecordRequest's read-side
// counterpart against the same store.
func (r *SQLiteRecorder) List(ctx context.Context, filter Filter) ([]Entry, error) {
	rows, err := r.store.ListRequests(ctx, auth.RequestLogFilter{
		Forge: string(filter.Forge),
	})
	if err != nil {
		return nil, fmt.Errorf("requestlog: list: %w", err)
	}

	out := make([]Entry, 0, len(rows))
	for _, row := range rows {
		out = append(out, Entry{
			ID:                 row.ID,
			LoggedAt:           row.LoggedAt,
			Forge:              dashboard.Forge(row.Forge),
			Method:             row.Method,
			Endpoint:           row.Endpoint,
			StatusCode:         row.StatusCode,
			Outcome:            row.Outcome,
			RateLimitLimit:     row.RateLimitLimit,
			RateLimitRemaining: row.RateLimitRemaining,
			RateLimitResetsAt:  row.RateLimitResetsAt,
			RateLimitCost:      row.RateLimitCost,
		})
	}

	return out, nil
}
