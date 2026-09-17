package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// ErrNotFound is returned by a lookup that found nothing — a sentinel
// rather than a typed error, since every caller only ever needs to know
// which kind, not reach anything out of it.
var ErrNotFound = errors.New("auth: not found")

// Store persists users, their passkey credentials, in-flight WebAuthn
// ceremonies, and sessions. It owns no driver of its own — cmd wires up
// whichever database/sql driver is registered (modernc.org/sqlite) and
// hands Store a plain *sql.DB.
type Store struct {
	db *sql.DB
}

// NewStore wraps db. Init must be called once before any other method.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Init creates the schema if it doesn't already exist. Safe to call every
// startup.
func (s *Store) Init(ctx context.Context) error {
	const schema = `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		username TEXT NOT NULL UNIQUE,
		display_name TEXT NOT NULL,
		is_admin INTEGER NOT NULL DEFAULT 0,
		credentials_json TEXT NOT NULL DEFAULT '[]',
		created_at TIMESTAMP NOT NULL
	);

	CREATE TABLE IF NOT EXISTS ceremonies (
		username TEXT NOT NULL,
		kind TEXT NOT NULL,
		session_json TEXT NOT NULL,
		expires_at TIMESTAMP NOT NULL,
		PRIMARY KEY (username, kind)
	);

	CREATE TABLE IF NOT EXISTS sessions (
		token TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		expires_at TIMESTAMP NOT NULL,
		created_at TIMESTAMP NOT NULL
	);

	CREATE TABLE IF NOT EXISTS api_tokens (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		label TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		created_at TIMESTAMP NOT NULL,
		last_used_at TIMESTAMP
	);
	`
	_, err := s.db.ExecContext(ctx, schema)
	return err
}

// CreateUser registers a brand-new account with no credentials yet —
// AddCredential attaches the first one once the registration ceremony
// that follows actually succeeds.
func (s *Store) CreateUser(ctx context.Context, username, displayName string, isAdmin bool) (*User, error) {
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return nil, fmt.Errorf("auth: generate user id: %w", err)
	}

	u := &User{
		ID:          id,
		Username:    username,
		DisplayName: displayName,
		IsAdmin:     isAdmin,
		Credentials: []webauthn.Credential{},
		CreatedAt:   time.Now().UTC(),
	}

	credsJSON, err := json.Marshal(u.Credentials)
	if err != nil {
		return nil, err
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, display_name, is_admin, credentials_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		encodeID(id), username, displayName, boolToInt(isAdmin), string(credsJSON), u.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	return u, nil
}

// DeleteUnregisteredUser removes username's account if — and only if — it
// has no credentials attached: an abandoned registration (begun, never
// finished, so nothing was ever actually attached to the username) rather
// than a real account. A no-op if the account has since gained a
// credential, or doesn't exist at all.
func (s *Store) DeleteUnregisteredUser(ctx context.Context, username string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE username = ? AND credentials_json = '[]'`, username)
	return err
}

// GetUserByUsername returns ErrNotFound when no such user is registered.
func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, display_name, is_admin, credentials_json, created_at FROM users WHERE username = ?`,
		username,
	)
	return scanUser(row)
}

// GetUserByID returns ErrNotFound when no such user is registered. id is
// the raw WebAuthn user handle, the same bytes User.ID holds.
func (s *Store) GetUserByID(ctx context.Context, id []byte) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, display_name, is_admin, credentials_json, created_at FROM users WHERE id = ?`,
		encodeID(id),
	)
	return scanUser(row)
}

// HasAnyRegisteredUser reports whether any account has completed
// registration — a row with no credentials (BeginRegistration begun,
// never finished) doesn't count. The first username to make this true
// is the one that becomes admin.
func (s *Store) HasAnyRegisteredUser(ctx context.Context) (bool, error) {
	var exists int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM users WHERE credentials_json != '[]' LIMIT 1`,
	).Scan(&exists)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	default:
		return true, nil
	}
}

// ListUsers returns every registered account, for the admin area.
func (s *Store) ListUsers(ctx context.Context) ([]*User, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, username, display_name, is_admin, credentials_json, created_at FROM users ORDER BY username`,
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var users []*User
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// rowScanner is the common surface of *sql.Row and *sql.Rows that scanUser
// needs — one field-mapping function shared by a single-row lookup and a
// ListUsers loop.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanUser(row rowScanner) (*User, error) {
	var (
		idStr, credsJSON string
		u                User
		isAdmin          int
	)
	if err := row.Scan(&idStr, &u.Username, &u.DisplayName, &isAdmin, &credsJSON, &u.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}

	id, err := decodeID(idStr)
	if err != nil {
		return nil, err
	}
	u.ID = id
	u.IsAdmin = isAdmin != 0

	if err := json.Unmarshal([]byte(credsJSON), &u.Credentials); err != nil {
		return nil, fmt.Errorf("auth: decode stored credentials: %w", err)
	}
	return &u, nil
}

// AddCredential appends cred to userID's stored credentials — a brand-new
// passkey, from a just-finished registration ceremony.
func (s *Store) AddCredential(ctx context.Context, userID []byte, cred webauthn.Credential) error {
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	u.Credentials = append(u.Credentials, cred)
	return s.saveCredentials(ctx, u)
}

// UpdateCredential replaces the stored credential sharing cred's ID —
// FinishLogin bumps the authenticator's signature counter on every
// successful login, and that has to be persisted to catch a cloned
// authenticator on a later login.
func (s *Store) UpdateCredential(ctx context.Context, userID []byte, cred webauthn.Credential) error {
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}
	for i, existing := range u.Credentials {
		if string(existing.ID) == string(cred.ID) {
			u.Credentials[i] = cred
			return s.saveCredentials(ctx, u)
		}
	}
	return fmt.Errorf("auth: credential %x not found for user", cred.ID)
}

func (s *Store) saveCredentials(ctx context.Context, u *User) error {
	credsJSON, err := json.Marshal(u.Credentials)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE users SET credentials_json = ? WHERE id = ?`, string(credsJSON), encodeID(u.ID))
	return err
}

// SaveCeremony records the in-flight WebAuthn session data for username's
// registration or login attempt, replacing any earlier one of the same
// kind — a user can only ever be partway through one ceremony at a time.
func (s *Store) SaveCeremony(ctx context.Context, username, kind string, session webauthn.SessionData, ttl time.Duration) error {
	data, err := json.Marshal(session)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO ceremonies (username, kind, session_json, expires_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (username, kind) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at`,
		username, kind, string(data), time.Now().UTC().Add(ttl),
	)
	return err
}

// LoadCeremony returns ErrNotFound when there's no in-flight ceremony of
// that kind for username, or it already expired.
func (s *Store) LoadCeremony(ctx context.Context, username, kind string) (webauthn.SessionData, error) {
	var (
		data      string
		expiresAt time.Time
	)
	err := s.db.QueryRowContext(ctx,
		`SELECT session_json, expires_at FROM ceremonies WHERE username = ? AND kind = ?`,
		username, kind,
	).Scan(&data, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return webauthn.SessionData{}, ErrNotFound
	}
	if err != nil {
		return webauthn.SessionData{}, err
	}
	if time.Now().UTC().After(expiresAt) {
		return webauthn.SessionData{}, ErrNotFound
	}

	var session webauthn.SessionData
	if err := json.Unmarshal([]byte(data), &session); err != nil {
		return webauthn.SessionData{}, fmt.Errorf("auth: decode stored ceremony: %w", err)
	}
	return session, nil
}

// DeleteCeremony clears the in-flight ceremony once it's finished, win or
// lose — it's single-use either way.
func (s *Store) DeleteCeremony(ctx context.Context, username, kind string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM ceremonies WHERE username = ? AND kind = ?`, username, kind)
	return err
}

// CreateSession issues a new opaque session token for userID, valid for
// ttl.
func (s *Store) CreateSession(ctx context.Context, userID []byte, ttl time.Duration) (token string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate session token: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(raw)

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		token, encodeID(userID), now.Add(ttl), now,
	)
	if err != nil {
		return "", err
	}
	return token, nil
}

// UserForSession returns the user a valid, unexpired session token
// belongs to, or ErrNotFound.
func (s *Store) UserForSession(ctx context.Context, token string) (*User, error) {
	var (
		userIDStr string
		expiresAt time.Time
	)
	err := s.db.QueryRowContext(ctx, `SELECT user_id, expires_at FROM sessions WHERE token = ?`, token).
		Scan(&userIDStr, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if time.Now().UTC().After(expiresAt) {
		return nil, ErrNotFound
	}

	id, err := decodeID(userIDStr)
	if err != nil {
		return nil, err
	}
	return s.GetUserByID(ctx, id)
}

// DeleteSession revokes a session token — logout, or an admin revoking
// another user's session.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}

// RevokeUser signs userID out everywhere and clears every registered
// passkey, without deleting the account itself — they have to register a
// new passkey from scratch to get back in, same as BeginRegistration
// reclaiming an abandoned one. Also revokes every API token: "signed out
// everywhere" has to mean everywhere a request can authenticate as this
// user, not just the session-cookie path.
func (s *Store) RevokeUser(ctx context.Context, userID []byte) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET credentials_json = '[]' WHERE id = ?`, encodeID(userID)); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, encodeID(userID)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE user_id = ?`, encodeID(userID))
	return err
}

// DeleteUser removes the account and every session it holds — irreversible,
// and the caller's job to also clean up anything outside this store (saved
// forge credentials, a running dashboard refresh).
func (s *Store) DeleteUser(ctx context.Context, userID []byte) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, encodeID(userID)); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE user_id = ?`, encodeID(userID)); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, encodeID(userID))
	return err
}

// apiTokenPrefix marks a generated token as forge-dashboard's own at a
// glance, the same recognizability GitHub's ghp_/github_pat_ prefixes
// give a secret scanner — nothing here ever parses it back out, since
// UserForAPIToken looks a token up by the hash of the whole string.
const apiTokenPrefix = "fdb_"

// hashAPIToken is what's actually stored and compared, never the raw
// token — unlike a session cookie (store.go's own CreateSession/
// UserForSession, stored and compared raw), a personal API token is a
// long-lived, copy-pasted, exportable secret, closer in risk to a
// password than to an HttpOnly cookie that never leaves the browser.
// SHA-256 alone (no per-token salt) is enough here specifically because
// the input is already a uniformly random 256-bit secret, not a
// human-chosen password an attacker could feasibly enumerate.
func hashAPIToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// CreateAPIToken generates a brand-new personal API token for userID,
// labeled label. raw is the only time the actual credential is ever
// returned — only its hash is stored, so losing it means generating a
// new one, the same "show once" handling a real secret needs.
func (s *Store) CreateAPIToken(ctx context.Context, userID []byte, label string) (raw string, tok *APIToken, err error) {
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return "", nil, fmt.Errorf("auth: generate api token id: %w", err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, fmt.Errorf("auth: generate api token: %w", err)
	}
	raw = apiTokenPrefix + base64.RawURLEncoding.EncodeToString(secret)

	tok = &APIToken{
		ID:        encodeID(idBytes),
		Label:     label,
		CreatedAt: time.Now().UTC(),
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO api_tokens (id, user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
		tok.ID, encodeID(userID), label, hashAPIToken(raw), tok.CreatedAt,
	)
	if err != nil {
		return "", nil, err
	}
	return raw, tok, nil
}

// ListAPITokens returns userID's own live tokens, oldest first.
func (s *Store) ListAPITokens(ctx context.Context, userID []byte) ([]*APIToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at, id`,
		encodeID(userID),
	)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var tokens []*APIToken
	for rows.Next() {
		var (
			tok        APIToken
			lastUsedAt sql.NullTime
		)
		if err := rows.Scan(&tok.ID, &tok.Label, &tok.CreatedAt, &lastUsedAt); err != nil {
			return nil, err
		}
		if lastUsedAt.Valid {
			t := lastUsedAt.Time
			tok.LastUsedAt = &t
		}
		tokens = append(tokens, &tok)
	}
	return tokens, rows.Err()
}

// UserForAPIToken returns the user raw belongs to, or ErrNotFound — the
// Bearer-token equivalent of UserForSession. Also records this as the
// token's most recent use, best-effort: a failure to persist that
// doesn't fail a request the token has already authenticated.
func (s *Store) UserForAPIToken(ctx context.Context, raw string) (*User, error) {
	hash := hashAPIToken(raw)
	var userIDStr string
	err := s.db.QueryRowContext(ctx, `SELECT user_id FROM api_tokens WHERE token_hash = ?`, hash).Scan(&userIDStr)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	if _, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`, time.Now().UTC(), hash); err != nil {
		slog.Warn("could not record api token use", "error", err)
	}

	id, err := decodeID(userIDStr)
	if err != nil {
		return nil, err
	}
	return s.GetUserByID(ctx, id)
}

// DeleteAPIToken revokes id, scoped to userID so one user can never
// revoke another's token by guessing an id — idempotent, same as
// DeleteUser's own sessions cleanup: deleting one that's already gone,
// or never belonged to userID, is not an error.
func (s *Store) DeleteAPIToken(ctx context.Context, userID []byte, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ? AND user_id = ?`, id, encodeID(userID))
	return err
}

// encodeID/decodeID round-trip the raw WebAuthn user handle through a
// column that's easier to index and compare as text than as a BLOB.
func encodeID(id []byte) string { return base64.RawURLEncoding.EncodeToString(id) }

func decodeID(s string) ([]byte, error) {
	id, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("auth: decode stored user id: %w", err)
	}
	return id, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
