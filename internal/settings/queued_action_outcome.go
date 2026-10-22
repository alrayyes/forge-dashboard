package settings

import (
	"context"
	"fmt"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// UpdateQueuedAction saves the status, reset time, outcome and finish time of
// the queued action q, and reports whether a waiting one was there to
// update. Only a waiting action changes: one cancelled meanwhile stays gone,
// and one already finished keeps its outcome.
func (s *Store) UpdateQueuedAction(ctx context.Context, q dashboard.QueuedAction) (bool, error) {
	var finishedAt any
	if q.FinishedAt != nil {
		finishedAt = q.FinishedAt.UTC()
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE queued_actions SET status = ?, run_at = ?, finished_at = ?, code = ?, message = ?
		 WHERE id = ? AND status = ?`,
		string(q.Status), q.RunAt.UTC(), finishedAt, string(q.Code), q.Message,
		q.ID, string(dashboard.QueuedWaiting),
	)
	if err != nil {
		return false, fmt.Errorf("settings: update queued action: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("settings: update queued action: %w", err)
	}

	return n > 0, nil
}

// PruneQueuedActions deletes finished queued actions that finished
// before cutoff. Waiting ones are never pruned.
func (s *Store) PruneQueuedActions(ctx context.Context, cutoff time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM queued_actions WHERE status != ? AND finished_at < ?`,
		string(dashboard.QueuedWaiting), cutoff.UTC(),
	)
	if err != nil {
		return fmt.Errorf("settings: prune queued actions: %w", err)
	}

	return nil
}

// HasWaitingQueuedActions reports whether any queued action still waits, so a
// restarted server can start the dashboard and keep the promise to run it at
// the reset.
func (s *Store) HasWaitingQueuedActions(ctx context.Context) (bool, error) {
	var waiting bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM queued_actions WHERE status = ?)`, string(dashboard.QueuedWaiting)).Scan(&waiting)
	if err != nil {
		return false, fmt.Errorf("settings: look for waiting queued actions: %w", err)
	}

	return waiting, nil
}
