package settings

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"
)

// ErrNotFound is returned when a user has never saved any credentials.
var ErrNotFound = errors.New("settings: not found")

// Credentials is one user's forge configuration, decrypted and ready to
// use — never itself serialized back to a client once saved; see
// internal/api's settings handlers for what does reach the browser.
type Credentials struct {
	GitHubToken     string
	GitHubUsername  string
	ForgejoURL      string
	ForgejoToken    string
	ForgejoUsername string
	UpdatedAt       time.Time
}

// Store persists Credentials, encrypted at rest, one row per user.
type Store struct {
	db     *sql.DB
	cipher *Cipher
}

// NewStore wraps db, encrypting and decrypting every token field through
// cipher. Init must be called once before any other method.
func NewStore(db *sql.DB, cipher *Cipher) *Store {
	return &Store{db: db, cipher: cipher}
}

// Init creates the schema if it doesn't already exist. Safe to call every
// startup.
func (s *Store) Init(ctx context.Context) error {
	const schema = `
	CREATE TABLE IF NOT EXISTS user_credentials (
		user_id TEXT PRIMARY KEY,
		github_token TEXT NOT NULL DEFAULT '',
		github_username TEXT NOT NULL DEFAULT '',
		forgejo_url TEXT NOT NULL DEFAULT '',
		forgejo_token TEXT NOT NULL DEFAULT '',
		forgejo_username TEXT NOT NULL DEFAULT '',
		updated_at TIMESTAMP NOT NULL
	);
	`
	_, err := s.db.ExecContext(ctx, schema)
	return err
}

// Set replaces userID's entire credential row — a Settings save is always
// a full form submit, not a partial patch.
func (s *Store) Set(ctx context.Context, userID []byte, c Credentials) error {
	encGitHubToken, err := s.cipher.Encrypt(c.GitHubToken)
	if err != nil {
		return err
	}
	encForgejoToken, err := s.cipher.Encrypt(c.ForgejoToken)
	if err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO user_credentials
			(user_id, github_token, github_username, forgejo_url, forgejo_token, forgejo_username, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET
			github_token = excluded.github_token,
			github_username = excluded.github_username,
			forgejo_url = excluded.forgejo_url,
			forgejo_token = excluded.forgejo_token,
			forgejo_username = excluded.forgejo_username,
			updated_at = excluded.updated_at`,
		encodeUserID(userID), encGitHubToken, c.GitHubUsername, c.ForgejoURL, encForgejoToken, c.ForgejoUsername, time.Now().UTC(),
	)
	return err
}

// Get returns ErrNotFound when userID has never saved any credentials.
func (s *Store) Get(ctx context.Context, userID []byte) (Credentials, error) {
	var (
		c                               Credentials
		encGitHubToken, encForgejoToken string
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT github_token, github_username, forgejo_url, forgejo_token, forgejo_username, updated_at
		FROM user_credentials WHERE user_id = ?`,
		encodeUserID(userID),
	).Scan(&encGitHubToken, &c.GitHubUsername, &c.ForgejoURL, &encForgejoToken, &c.ForgejoUsername, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Credentials{}, ErrNotFound
	}
	if err != nil {
		return Credentials{}, err
	}

	if c.GitHubToken, err = s.cipher.Decrypt(encGitHubToken); err != nil {
		return Credentials{}, err
	}
	if c.ForgejoToken, err = s.cipher.Decrypt(encForgejoToken); err != nil {
		return Credentials{}, err
	}
	return c, nil
}

func encodeUserID(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }
