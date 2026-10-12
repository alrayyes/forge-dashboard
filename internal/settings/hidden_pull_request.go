package settings

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// hiddenPullRequestsSchema is the table HidePullRequest writes. hidden_until is
// NULL for a hide that lasts until the user restores it.
const hiddenPullRequestsSchema = `
	CREATE TABLE IF NOT EXISTS hidden_pull_requests (
		user_id TEXT NOT NULL,
		forge TEXT NOT NULL,
		repo_full_name TEXT NOT NULL,
		number INTEGER NOT NULL,
		hidden_until TIMESTAMP,
		PRIMARY KEY (user_id, forge, repo_full_name, number)
	);
`

// HiddenPullRequest is one pull request a user hid from their dashboard
// (#841). Until is when the hide ends by itself; the zero time means it stays
// hidden until the user restores it.
type HiddenPullRequest struct {
	Forge  string
	Repo   string
	Number int
	Until  time.Time
}

// HidePullRequest hides one pull request from userID's dashboard, until the
// given time, or until restored when until is the zero time. Nothing is sent to
// the forge. A repeat call replaces the earlier choice.
func (s *Store) HidePullRequest(ctx context.Context, userID []byte, forge, repoFullName string, number int, until time.Time) error {
	var endsAt sql.NullTime
	if !until.IsZero() {
		endsAt = sql.NullTime{Time: until.UTC(), Valid: true}
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO hidden_pull_requests (user_id, forge, repo_full_name, number, hidden_until)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, forge, repo_full_name, number) DO UPDATE SET hidden_until = excluded.hidden_until`,
		encodeUserID(userID), forge, repoFullName, number, endsAt,
	)
	if err != nil {
		return fmt.Errorf("settings: hide pull request: %w", err)
	}

	return nil
}

// UnhidePullRequest reverses HidePullRequest. Idempotent: restoring a pull
// request that isn't hidden is a no-op, not an error.
func (s *Store) UnhidePullRequest(ctx context.Context, userID []byte, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM hidden_pull_requests WHERE user_id = ? AND forge = ? AND repo_full_name = ? AND number = ?`,
		encodeUserID(userID), forge, repoFullName, number,
	)
	if err != nil {
		return fmt.Errorf("settings: unhide pull request: %w", err)
	}

	return nil
}

// HiddenPullRequests returns, keyed by AutoMergeKey, every pull request userID
// has hidden that is still hidden at now: empty, never an error, for a user who
// has hidden none. A hide whose time has passed is deleted here, so an expired
// one never comes back and the table doesn't keep it.
func (s *Store) HiddenPullRequests(ctx context.Context, userID []byte, now time.Time) (map[string]HiddenPullRequest, error) {
	encodedID := encodeUserID(userID)
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM hidden_pull_requests WHERE user_id = ? AND hidden_until IS NOT NULL AND hidden_until <= ?`,
		encodedID, now.UTC(),
	); err != nil {
		return nil, fmt.Errorf("settings: drop expired hidden pull requests: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name, number, hidden_until FROM hidden_pull_requests WHERE user_id = ?`, encodedID,
	)
	if err != nil {
		return nil, fmt.Errorf("settings: list hidden pull requests: %w", err)
	}
	defer func() { _ = rows.Close() }()

	hidden := make(map[string]HiddenPullRequest)
	for rows.Next() {
		var h HiddenPullRequest
		var until sql.NullTime
		if err := rows.Scan(&h.Forge, &h.Repo, &h.Number, &until); err != nil {
			return nil, fmt.Errorf("settings: scan hidden pull request row: %w", err)
		}
		if until.Valid {
			h.Until = until.Time
		}
		hidden[AutoMergeKey(h.Forge, h.Repo, h.Number)] = h
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list hidden pull requests: %w", err)
	}

	return hidden, nil
}

// ForgetHiddenPullRequests deletes the named hides, for pull requests that are
// no longer open. Only the forge, repo and number of each are read.
func (s *Store) ForgetHiddenPullRequests(ctx context.Context, userID []byte, gone []HiddenPullRequest) error {
	for _, h := range gone {
		if err := s.UnhidePullRequest(ctx, userID, h.Forge, h.Repo, h.Number); err != nil {
			return fmt.Errorf("settings: forget hidden pull request: %w", err)
		}
	}

	return nil
}
