package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/oauth2"
)

// oauthTokensSchema holds the token pair each OAuth connection (#3951) was
// granted, one row per forge. The whole pair is one encrypted blob, so a
// rotated refresh token and its new access token are written by a single
// statement and can't be left half updated.
//
//nolint:gosec // G101: a table definition, not a credential.
const oauthTokensSchema = `
	CREATE TABLE IF NOT EXISTS oauth_tokens (
		forge TEXT PRIMARY KEY,
		token TEXT NOT NULL,
		updated_at TIMESTAMP NOT NULL
	);
`

// SaveOAuthToken stores the token pair for forge, encrypted, replacing any
// earlier pair in one statement. GitHub rotates the refresh token on every
// refresh, so callers save the new pair as soon as they get it.
func (s *Store) SaveOAuthToken(ctx context.Context, forge string, token *oauth2.Token) error {
	// The pair is sealed by the cipher below before it reaches the database.
	raw, err := json.Marshal(token) //nolint:gosec // G117: encrypted before it is stored.
	if err != nil {
		return fmt.Errorf("settings: encode oauth token: %w", err)
	}

	sealed, err := s.cipher.Encrypt(string(raw))
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO oauth_tokens (forge, token, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT (forge) DO UPDATE SET token = excluded.token, updated_at = excluded.updated_at`,
		forge, sealed,
	)
	if err != nil {
		return fmt.Errorf("settings: save oauth token: %w", err)
	}

	return nil
}

// OAuthToken returns the decrypted token pair for forge, or ErrNotFound when
// the forge was never linked.
func (s *Store) OAuthToken(ctx context.Context, forge string) (*oauth2.Token, error) {
	var sealed string

	err := s.db.QueryRowContext(ctx, `SELECT token FROM oauth_tokens WHERE forge = ?`, forge).Scan(&sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}

	if err != nil {
		return nil, fmt.Errorf("settings: read oauth token: %w", err)
	}

	raw, err := s.cipher.Decrypt(sealed)
	if err != nil {
		return nil, err
	}

	var token oauth2.Token
	if err := json.Unmarshal([]byte(raw), &token); err != nil {
		return nil, fmt.Errorf("settings: decode oauth token: %w", err)
	}

	return &token, nil
}

// DeleteOAuthToken unlinks forge by removing its token pair.
func (s *Store) DeleteOAuthToken(ctx context.Context, forge string) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM oauth_tokens WHERE forge = ?`, forge); err != nil {
		return fmt.Errorf("settings: delete oauth token: %w", err)
	}

	return nil
}

// HasOAuthToken reports whether forge is linked, without decrypting anything.
func (s *Store) HasOAuthToken(ctx context.Context, forge string) (bool, error) {
	var one int

	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM oauth_tokens WHERE forge = ?`, forge).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}

	if err != nil {
		return false, fmt.Errorf("settings: check oauth token: %w", err)
	}

	return true, nil
}
