package settings

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// queuedActionsSchema is the table Init adds to the rest of the schema. Rows
// of every user share it, told apart by user_id, like the other per-user tables.
const queuedActionsSchema = `
	CREATE TABLE IF NOT EXISTS queued_actions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		action TEXT NOT NULL,
		forge TEXT NOT NULL,
		repo_full_name TEXT NOT NULL,
		number INTEGER NOT NULL,
		status TEXT NOT NULL,
		run_at TIMESTAMP NOT NULL,
		created_at TIMESTAMP NOT NULL,
		finished_at TIMESTAMP,
		code TEXT NOT NULL DEFAULT '',
		message TEXT NOT NULL DEFAULT ''
	);
	CREATE INDEX IF NOT EXISTS queued_actions_user ON queued_actions (user_id);
`

// queuedActionColumns is the column list every queued-action read selects, in
// the order scanQueuedAction reads them.
const queuedActionColumns = `id, action, forge, repo_full_name, number, status, run_at, created_at, finished_at, code, message`

// EnqueueQueuedAction stores a safe action for userID to run once a forge's
// rate limit resets (#756) and returns it with its new ID and true. Idempotent: a
// second request for the same action on the same pull request while the first
// still waits returns the first, unchanged, and false, rather than stacking a
// duplicate.
func (s *Store) EnqueueQueuedAction(ctx context.Context, userID []byte, q dashboard.QueuedAction) (dashboard.QueuedAction, bool, error) {
	encodedID := encodeUserID(userID)

	row := s.db.QueryRowContext(ctx,
		`SELECT `+queuedActionColumns+` FROM queued_actions
		 WHERE user_id = ? AND action = ? AND forge = ? AND repo_full_name = ? AND number = ? AND status = ?`,
		encodedID, string(q.Action), string(q.Forge), q.Repo, q.Number, string(dashboard.QueuedWaiting),
	)
	existing, err := scanQueuedAction(row)
	switch {
	case err == nil:
		return existing, false, nil
	case !errors.Is(err, sql.ErrNoRows):
		return dashboard.QueuedAction{}, false, fmt.Errorf("settings: look up queued action: %w", err)
	}

	id, err := newQueuedActionID()
	if err != nil {
		return dashboard.QueuedAction{}, false, err
	}
	q.ID = id
	q.Status = dashboard.QueuedWaiting
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO queued_actions (id, user_id, action, forge, repo_full_name, number, status, run_at, created_at, code, message)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
		q.ID, encodedID, string(q.Action), string(q.Forge), q.Repo, q.Number, string(q.Status), q.RunAt.UTC(), q.CreatedAt.UTC(),
	)
	if err != nil {
		return dashboard.QueuedAction{}, false, fmt.Errorf("settings: enqueue queued action: %w", err)
	}

	return q, true, nil
}

// QueuedActions returns every queued action userID has, waiting or finished,
// oldest first — empty, never nil or an error, for a user with none.
func (s *Store) QueuedActions(ctx context.Context, userID []byte) ([]dashboard.QueuedAction, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT `+queuedActionColumns+` FROM queued_actions WHERE user_id = ? ORDER BY created_at, id`, encodeUserID(userID),
	)
	if err != nil {
		return nil, fmt.Errorf("settings: list queued actions: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []dashboard.QueuedAction{}
	for rows.Next() {
		q, err := scanQueuedAction(rows)
		if err != nil {
			return nil, fmt.Errorf("settings: scan queued action: %w", err)
		}
		out = append(out, q)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list queued actions: %w", err)
	}

	return out, nil
}

// CancelQueuedAction removes userID's queued action id, waiting or finished,
// and reports whether there was one. Another user's id is not found, so one
// account can neither see nor cancel another's queue.
func (s *Store) CancelQueuedAction(ctx context.Context, userID []byte, id string) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM queued_actions WHERE user_id = ? AND id = ?`, encodeUserID(userID), id)
	if err != nil {
		return false, fmt.Errorf("settings: cancel queued action: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("settings: cancel queued action: %w", err)
	}

	return n > 0, nil
}

// rowScanner is what *sql.Row and *sql.Rows share.
type rowScanner interface{ Scan(dest ...any) error }

func scanQueuedAction(row rowScanner) (dashboard.QueuedAction, error) {
	var (
		q                           dashboard.QueuedAction
		action, forge, status, code string
		finishedAt                  sql.NullTime
	)
	if err := row.Scan(&q.ID, &action, &forge, &q.Repo, &q.Number, &status, &q.RunAt, &q.CreatedAt, &finishedAt, &code, &q.Message); err != nil {
		return dashboard.QueuedAction{}, err //nolint:wrapcheck // callers add the operation
	}
	q.Action, q.Forge, q.Status, q.Code = dashboard.ActionName(action), dashboard.Forge(forge), dashboard.QueuedStatus(status), dashboard.ActionCode(code)
	q.RunAt, q.CreatedAt = q.RunAt.UTC(), q.CreatedAt.UTC()
	if finishedAt.Valid {
		at := finishedAt.Time.UTC()
		q.FinishedAt = &at
	}

	return q, nil
}

func newQueuedActionID() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("settings: queued action id: %w", err)
	}

	return hex.EncodeToString(buf), nil
}
