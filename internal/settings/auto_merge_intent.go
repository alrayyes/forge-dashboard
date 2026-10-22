package settings

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// AutoMergeKey is how a pull request's forge, repo and number combine into the
// key AutoMergeIntents' returned set uses.
func AutoMergeKey(forge, repoFullName string, number int) string {
	return forge + "/" + repoFullName + "#" + strconv.Itoa(number)
}

// ParseAutoMergeKey is AutoMergeKey the other way round: the forge, repo and
// number a key was built from. False for a string that isn't one.
func ParseAutoMergeKey(key string) (PullRequestRef, bool) {
	forge, rest, ok := strings.Cut(key, "/")
	if !ok {
		return PullRequestRef{}, false
	}
	repo, last, ok := strings.CutLast(rest, "#")
	if !ok {
		return PullRequestRef{}, false
	}
	number, err := strconv.Atoi(last)
	if err != nil {
		return PullRequestRef{}, false
	}

	return PullRequestRef{Forge: forge, Repo: repo, Number: number}, true
}

// ArmAutoMerge records that the user asked this app to merge the pull request
// once its checks pass. Forgejo's pull request JSON has no auto-merge field, so
// the app's own intent lives here. Idempotent: arming an armed pull request keeps the
// original time.
func (s *Store) ArmAutoMerge(ctx context.Context, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO auto_merge_intents (forge, repo_full_name, number, armed_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (forge, repo_full_name, number) DO NOTHING`,
		forge, repoFullName, number, time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("settings: arm auto-merge: %w", err)
	}

	return nil
}

// CancelAutoMerge reverses ArmAutoMerge. Idempotent: cancelling a pull
// request that was never armed is a no-op, not an error.
func (s *Store) CancelAutoMerge(ctx context.Context, forge, repoFullName string, number int) error {
	_, err := s.db.ExecContext(ctx, `
		DELETE FROM auto_merge_intents WHERE forge = ? AND repo_full_name = ? AND number = ?`,
		forge, repoFullName, number,
	)
	if err != nil {
		return fmt.Errorf("settings: cancel auto-merge: %w", err)
	}

	return nil
}

// AutoMergeIntents returns, keyed by AutoMergeKey, every pull request the user
// has armed — empty, never an error, when none is armed.
func (s *Store) AutoMergeIntents(ctx context.Context) (map[string]struct{}, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT forge, repo_full_name, number FROM auto_merge_intents`,
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
