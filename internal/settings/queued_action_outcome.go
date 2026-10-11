package settings

import (
	"context"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// UpdateQueuedAction saves the status, reset time, outcome and finish time of
// userID's queued action q, and reports whether a waiting one was there to
// update. Only a waiting action changes: one cancelled meanwhile stays gone,
// and one already finished keeps its outcome.
func (s *Store) UpdateQueuedAction(ctx context.Context, userID []byte, q dashboard.QueuedAction) (bool, error) {
	var finishedAt any
	if q.FinishedAt != nil {
		finishedAt = q.FinishedAt.UTC()
	}
	res, err := s.db.ExecContext(ctx,
		`UPDATE queued_actions SET status = ?, run_at = ?, finished_at = ?, code = ?, message = ?
		 WHERE user_id = ? AND id = ? AND status = ?`,
		string(q.Status), q.RunAt.UTC(), finishedAt, string(q.Code), q.Message,
		encodeUserID(userID), q.ID, string(dashboard.QueuedWaiting),
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

// PruneQueuedActions deletes userID's finished queued actions that finished
// before cutoff. Waiting ones are never pruned.
func (s *Store) PruneQueuedActions(ctx context.Context, userID []byte, cutoff time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM queued_actions WHERE user_id = ? AND status != ? AND finished_at < ?`,
		encodeUserID(userID), string(dashboard.QueuedWaiting), cutoff.UTC(),
	)
	if err != nil {
		return fmt.Errorf("settings: prune queued actions: %w", err)
	}

	return nil
}

// UsersWithWaitingQueuedActions lists every user who still has a queued action
// waiting, so a restarted server can start their dashboards and keep the
// promise to run it at the reset.
func (s *Store) UsersWithWaitingQueuedActions(ctx context.Context) ([][]byte, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT user_id FROM queued_actions WHERE status = ? ORDER BY user_id`, string(dashboard.QueuedWaiting))
	if err != nil {
		return nil, fmt.Errorf("settings: list users with queued actions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var users [][]byte
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, fmt.Errorf("settings: scan user with queued actions: %w", err)
		}
		id, err := base64.RawURLEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("settings: decode user id: %w", err)
		}
		users = append(users, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list users with queued actions: %w", err)
	}

	return users, nil
}
