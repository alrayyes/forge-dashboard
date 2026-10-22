package settings

import (
	"context"
	"fmt"
)

// pullRequestAutoUpdateSchema is the table SetPullRequestAutoUpdate writes. A
// row is one pull request's own choice about automatic branch updates, kept
// only while it differs from its repo's setting.
const pullRequestAutoUpdateSchema = `
	CREATE TABLE IF NOT EXISTS pull_request_auto_update (
		forge TEXT NOT NULL,
		repo_full_name TEXT NOT NULL,
		number INTEGER NOT NULL,
		enabled BOOLEAN NOT NULL,
		PRIMARY KEY (forge, repo_full_name, number)
	);
`

// PullRequestRef names one pull request.
type PullRequestRef struct {
	Forge  string
	Repo   string
	Number int
}

// SetPullRequestAutoUpdate records that the user wants this pull request's
// branch updated automatically (enabled) or left alone (not enabled), whatever
// its repo says. Nothing is sent to the forge. A repeat call replaces the
// earlier choice. The caller drops the record, with ClearPullRequestAutoUpdate,
// when the choice matches the repo's own setting, so the pull request follows
// the repo again.
func (s *Store) SetPullRequestAutoUpdate(ctx context.Context, forge, repoFullName string, number int, enabled bool) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO pull_request_auto_update (forge, repo_full_name, number, enabled)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (forge, repo_full_name, number) DO UPDATE SET enabled = excluded.enabled`,
		forge, repoFullName, number, enabled,
	)
	if err != nil {
		return fmt.Errorf("settings: set pull request auto-update: %w", err)
	}

	return nil
}

// ClearPullRequestAutoUpdate reverses SetPullRequestAutoUpdate, so the pull
// request follows its repo again. Idempotent: clearing one with no record is
// a no-op, not an error.
func (s *Store) ClearPullRequestAutoUpdate(ctx context.Context, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM pull_request_auto_update WHERE forge = ? AND repo_full_name = ? AND number = ?`,
		forge, repoFullName, number,
	)
	if err != nil {
		return fmt.Errorf("settings: clear pull request auto-update: %w", err)
	}

	return nil
}

// PullRequestAutoUpdates returns, keyed by AutoMergeKey, the user's own choice for
// each pull request that has one: empty, never an error, when none has.
func (s *Store) PullRequestAutoUpdates(ctx context.Context) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name, number, enabled FROM pull_request_auto_update`,
	)
	if err != nil {
		return nil, fmt.Errorf("settings: list pull request auto-update: %w", err)
	}
	defer func() { _ = rows.Close() }()

	choices := make(map[string]bool)
	for rows.Next() {
		var ref PullRequestRef
		var enabled bool
		if err := rows.Scan(&ref.Forge, &ref.Repo, &ref.Number, &enabled); err != nil {
			return nil, fmt.Errorf("settings: scan pull request auto-update row: %w", err)
		}
		choices[AutoMergeKey(ref.Forge, ref.Repo, ref.Number)] = enabled
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("settings: list pull request auto-update: %w", err)
	}

	return choices, nil
}

// ForgetPullRequestAutoUpdates deletes the choices named by their AutoMergeKey,
// those of pull requests that are gone or that now equal their repo's setting,
// so the table can't grow without end. A string that isn't a key is skipped.
func (s *Store) ForgetPullRequestAutoUpdates(ctx context.Context, keys []string) error {
	for _, key := range keys {
		ref, ok := ParseAutoMergeKey(key)
		if !ok {
			continue
		}
		if err := s.ClearPullRequestAutoUpdate(ctx, ref.Forge, ref.Repo, ref.Number); err != nil {
			return fmt.Errorf("settings: forget pull request auto-update: %w", err)
		}
	}

	return nil
}
