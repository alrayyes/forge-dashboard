package settings

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// oauthClientsSchema holds the client id of a public OAuth client the owner
// registered by hand, one row per forge. A client id is public by design (it
// is in every consent URL), so it is stored as plain text.
const oauthClientsSchema = `
	CREATE TABLE IF NOT EXISTS oauth_clients (
		forge TEXT PRIMARY KEY,
		client_id TEXT NOT NULL
	);
`

// SaveOAuthClientID remembers the client id forge's token pair was granted to.
func (s *Store) SaveOAuthClientID(ctx context.Context, forge, clientID string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO oauth_clients (forge, client_id) VALUES (?, ?)
		ON CONFLICT (forge) DO UPDATE SET client_id = excluded.client_id`, forge, clientID)
	if err != nil {
		return fmt.Errorf("settings: save oauth client id: %w", err)
	}

	return nil
}

// OAuthClientID returns the client id saved for forge, or "" when there is none.
func (s *Store) OAuthClientID(ctx context.Context, forge string) (string, error) {
	var id string

	err := s.db.QueryRowContext(ctx, `SELECT client_id FROM oauth_clients WHERE forge = ?`, forge).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}

	if err != nil {
		return "", fmt.Errorf("settings: read oauth client id: %w", err)
	}

	return id, nil
}

// DeleteOAuthClientID forgets the client id saved for forge.
func (s *Store) DeleteOAuthClientID(ctx context.Context, forge string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM oauth_clients WHERE forge = ?`, forge); err != nil {
		return fmt.Errorf("settings: delete oauth client id: %w", err)
	}

	return nil
}
