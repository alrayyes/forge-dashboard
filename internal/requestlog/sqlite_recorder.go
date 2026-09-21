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
//
// It's scoped to one account: SQLiteRecorder is constructed once per
// signed-in user (wherever that user's forge clients are built — see
// cmd/forge-dashboard's buildSourcesForUser), and every Entry it records
// carries that account's own ID regardless of what the caller set on
// Entry.AccountID — the account whose credential made a request is a
// property of *which client made it*, not something each individual
// client call site needs to know or pass through.
type SQLiteRecorder struct {
	store     *auth.Store
	accountID string
}

// NewSQLiteRecorder returns a SQLiteRecorder that persists into store,
// stamping every recorded Entry with accountID.
func NewSQLiteRecorder(store *auth.Store, accountID string) *SQLiteRecorder {
	return &SQLiteRecorder{store: store, accountID: accountID}
}

var _ Recorder = (*SQLiteRecorder)(nil)

// Record implements Recorder.
func (r *SQLiteRecorder) Record(ctx context.Context, e Entry) error {
	row := auth.RequestLogRow{
		LoggedAt:           e.LoggedAt,
		Forge:              string(e.Forge),
		AccountID:          r.accountID,
		Method:             e.Method,
		Endpoint:           e.Endpoint,
		StatusCode:         e.StatusCode,
		Outcome:            e.Outcome,
		RateLimitLimit:     e.RateLimitLimit,
		RateLimitRemaining: e.RateLimitRemaining,
		RateLimitResetsAt:  e.RateLimitResetsAt,
		RateLimitCost:      e.RateLimitCost,
	}
	if err := r.store.RecordRequest(ctx, row, MaxEntries); err != nil {
		return fmt.Errorf("requestlog: record: %w", err)
	}

	return nil
}

// List returns every entry matching filter, newest first — the admin
// API's own read path (internal/api's request-log handlers), kept on
// this same type rather than a second one, since it's just
// RecordRequest's read-side counterpart against the same store.
func (r *SQLiteRecorder) List(ctx context.Context, filter Filter) ([]Entry, error) {
	rows, err := r.store.ListRequests(ctx, auth.RequestLogFilter{
		Forge:     string(filter.Forge),
		AccountID: filter.AccountID,
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
			AccountID:          row.AccountID,
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
