package settings

import (
	"context"
	"fmt"
	"strconv"
	"time"
)

// AutoMergeKey is how a pull request's forge, repo and number combine into the
// key AutoMergeIntents' returned set uses.
func AutoMergeKey(forge, repoFullName string, number int) string {
	return forge + "/" + repoFullName + "#" + strconv.Itoa(number)
}

// ArmAutoMerge records that userID asked this app to merge the pull request
// once its checks pass. Forgejo can't report a scheduled merge back, so the
// intent lives here. Idempotent: arming an armed pull request keeps the
// original time.
func (s *Store) ArmAutoMerge(ctx context.Context, userID []byte, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auto_merge_intents (user_id, forge, repo_full_name, number, armed_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (user_id, forge, repo_full_name, number) DO NOTHING`,
		encodeUserID(userID), forge, repoFullName, number, time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("settings: arm auto-merge: %w", err)
	}

	return nil
}

// CancelAutoMerge reverses ArmAutoMerge. Idempotent: cancelling a pull
// request that was never armed is a no-op, not an error.
func (s *Store) CancelAutoMerge(ctx context.Context, userID []byte, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM auto_merge_intents WHERE user_id = ? AND forge = ? AND repo_full_name = ? AND number = ?`,
		encodeUserID(userID), forge, repoFullName, number,
	)
	if err != nil {
		return fmt.Errorf("settings: cancel auto-merge: %w", err)
	}

	return nil
}

// AutoMergeIntents returns, keyed by AutoMergeKey, every pull request userID
// has armed — empty, never an error, for a user who has armed none.
func (s *Store) AutoMergeIntents(ctx context.Context, userID []byte) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name, number FROM auto_merge_intents WHERE user_id = ?`, encodeUserID(userID),
	)
	if err != nil {
		return nil, fmt.Errorf("settings: list auto-merge intents: %w", err)
	}
	defer func() { _ = rows.Close() }()

	armed := make(map[string]struct{})
	for rows.Next() {
		var forge, repoFullName string
		var number int
		if err := rows.Scan(&forge, &repoFullName, &number); err != nil {
			return nil, fmt.Errorf("settings: scan auto-merge intent row: %w", err)
		}
		armed[AutoMergeKey(forge, repoFullName, number)] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list auto-merge intents: %w", err)
	}

	return armed, nil
}
