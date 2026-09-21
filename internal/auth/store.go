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
	"slices"
	"strings"
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
		expires_at TIMESTAMP,
		last_used_at TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS credential_metadata (
		user_id TEXT NOT NULL,
		credential_id TEXT NOT NULL,
		label TEXT NOT NULL,
		created_at TIMESTAMP NOT NULL,
		PRIMARY KEY (user_id, credential_id)
	);

	CREATE TABLE IF NOT EXISTS invites (
		token_hash TEXT PRIMARY KEY,
		username TEXT NOT NULL,
		display_name TEXT NOT NULL,
		created_by TEXT NOT NULL REFERENCES users(id),
		expires_at TIMESTAMP NOT NULL,
		consumed_at TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS request_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		logged_at TIMESTAMP NOT NULL,
		forge TEXT NOT NULL,
		account_id TEXT REFERENCES users(id),
		method TEXT NOT NULL,
		endpoint TEXT NOT NULL,
		status_code INTEGER,
		outcome TEXT NOT NULL,
		rate_limit_limit INTEGER,
		rate_limit_remaining INTEGER,
		rate_limit_resets_at TIMESTAMP,
		rate_limit_cost INTEGER
	);
	`
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("auth: create schema: %w", err)
	}

	return s.addColumnsIfMissing(ctx)
}

// addColumnsIfMissing exists for a database that already had api_tokens
// before expires_at was added — CREATE TABLE IF NOT EXISTS above is a
// no-op against it, so the column needs adding here instead. SQLite has
// no ADD COLUMN IF NOT EXISTS, so a "duplicate column name" error is the
// expected, ignored outcome on a database that already has it (including
// every fresh one, which got it from the CREATE TABLE above already) —
// the same pattern internal/settings' own Store.addColumnsIfMissing uses.
func (s *Store) addColumnsIfMissing(ctx context.Context) error {
	migrations := []string{
		`ALTER TABLE api_tokens ADD COLUMN expires_at TIMESTAMP`,
	}
	for _, stmt := range migrations {
		if _, err := s.db.ExecContext(ctx, stmt); err != nil {
			if strings.Contains(err.Error(), "duplicate column name") {
				continue
			}

			return fmt.Errorf("auth: add missing column: %w", err)
		}
	}

	return nil
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
		return nil, fmt.Errorf("auth: encode credentials: %w", err)
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, display_name, is_admin, credentials_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		encodeID(id), username, displayName, boolToInt(isAdmin), string(credsJSON), u.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("auth: insert user: %w", err)
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
	if err != nil {
		return fmt.Errorf("auth: delete unregistered user: %w", err)
	}

	return nil
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
		return false, fmt.Errorf("auth: check for a registered user: %w", err)
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
		return nil, fmt.Errorf("auth: list users: %w", err)
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
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list users: %w", err)
	}

	return users, nil
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

		return nil, fmt.Errorf("auth: scan user row: %w", err)
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
		return fmt.Errorf("auth: encode credentials: %w", err)
	}
	_, err = s.db.ExecContext(ctx, `UPDATE users SET credentials_json = ? WHERE id = ?`, string(credsJSON), encodeID(u.ID))
	if err != nil {
		return fmt.Errorf("auth: save credentials: %w", err)
	}

	return nil
}

// credentialIDKey is how a webauthn.Credential.ID becomes the key
// credential_metadata's own credential_id column stores and
// ListCredentials/Credential.ID hands back to a caller — base64url,
// the same encoding a credential ID already uses everywhere else in a
// WebAuthn ceremony (excludeCredentials, allowCredentials), not a
// second one invented just for this table.
func credentialIDKey(id []byte) string {
	return base64.RawURLEncoding.EncodeToString(id)
}

// SetCredentialLabel names credID (userID's own passkey) label — called
// once, right after AddCredential, for both the very first passkey a
// brand-new account registers and every one added afterward (#355), so
// Settings always has something to show even for an account that
// predates this feature having a UI of its own.
func (s *Store) SetCredentialLabel(ctx context.Context, userID []byte, credID []byte, label string) error {
	return s.setCredentialLabelAt(ctx, userID, credID, label, time.Now().UTC())
}

// setCredentialLabelAt is SetCredentialLabel with an explicit createdAt
// — used by Service.FinishAddCredential so the timestamp it hands back
// to a caller in the same response matches exactly what got persisted,
// rather than a fresh time.Now() taken moments later disagreeing with
// it by however long the write itself took.
func (s *Store) setCredentialLabelAt(ctx context.Context, userID []byte, credID []byte, label string, createdAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO credential_metadata (user_id, credential_id, label, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (user_id, credential_id) DO UPDATE SET label = excluded.label`,
		encodeID(userID), credentialIDKey(credID), label, createdAt,
	)
	if err != nil {
		return fmt.Errorf("auth: set credential label: %w", err)
	}

	return nil
}

// ListCredentials returns userID's own passkeys, oldest first — driven
// by the account's real webauthn.Credential list (the source of truth
// for what can actually authenticate), not credential_metadata alone,
// so a credential somehow missing its label row still appears rather
// than silently vanishing from the list. defaultLabel fills that gap:
// a credential from before this feature existed reads back with no
// metadata row at all.
func (s *Store) ListCredentials(ctx context.Context, userID []byte) ([]*Credential, error) {
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT credential_id, label, created_at FROM credential_metadata WHERE user_id = ?`,
		encodeID(userID),
	)
	if err != nil {
		return nil, fmt.Errorf("auth: list credential labels: %w", err)
	}
	defer func() { _ = rows.Close() }()

	type meta struct {
		label     string
		createdAt time.Time
	}
	byCredID := make(map[string]meta)
	for rows.Next() {
		var credID, label string
		var createdAt time.Time
		if err := rows.Scan(&credID, &label, &createdAt); err != nil {
			return nil, fmt.Errorf("auth: scan credential label row: %w", err)
		}
		byCredID[credID] = meta{label: label, createdAt: createdAt}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list credential labels: %w", err)
	}

	out := make([]*Credential, 0, len(u.Credentials))
	for _, cred := range u.Credentials {
		key := credentialIDKey(cred.ID)
		m, ok := byCredID[key]
		if !ok {
			m = meta{label: "Unnamed passkey", createdAt: u.CreatedAt}
		}
		out = append(out, &Credential{ID: key, Label: m.label, CreatedAt: m.createdAt})
	}
	slices.SortFunc(out, func(a, b *Credential) int { return a.CreatedAt.Compare(b.CreatedAt) })

	return out, nil
}

// ErrLastCredential is returned by RemoveCredential when credID is
// userID's only remaining passkey — this app is WebAuthn-only with no
// password fallback, so deleting it would lock the account out
// entirely (#355).
var ErrLastCredential = errors.New("auth: can't remove the account's last remaining passkey")

// RemoveCredential deletes credID from userID's account, scoped to that
// user so one account's own credential id can never be guessed into
// deleting another's — the same shape DeleteAPIToken's own scoping
// uses. Idempotent for an id that's unknown or already gone (matching
// DeleteAPIToken), but never for the account's last one: that's always
// ErrLastCredential, not silently skipped, so a caller (or a stale
// list somehow down to one) can't accidentally lock the account out.
func (s *Store) RemoveCredential(ctx context.Context, userID []byte, credID string) error {
	u, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}

	idx := -1
	for i, cred := range u.Credentials {
		if credentialIDKey(cred.ID) == credID {
			idx = i

			break
		}
	}
	if idx == -1 {
		return nil
	}
	if len(u.Credentials) <= 1 {
		return ErrLastCredential
	}

	u.Credentials = slices.Delete(u.Credentials, idx, idx+1)
	if err := s.saveCredentials(ctx, u); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM credential_metadata WHERE user_id = ? AND credential_id = ?`, encodeID(userID), credID)
	if err != nil {
		return fmt.Errorf("auth: delete credential metadata: %w", err)
	}

	return nil
}

// SaveCeremony records the in-flight WebAuthn session data for username's
// registration or login attempt, replacing any earlier one of the same
// kind — a user can only ever be partway through one ceremony at a time.
func (s *Store) SaveCeremony(ctx context.Context, username, kind string, session webauthn.SessionData, ttl time.Duration) error {
	data, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("auth: encode ceremony session: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO ceremonies (username, kind, session_json, expires_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (username, kind) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at`,
		username, kind, string(data), time.Now().UTC().Add(ttl),
	)
	if err != nil {
		return fmt.Errorf("auth: save ceremony: %w", err)
	}

	return nil
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
		return webauthn.SessionData{}, fmt.Errorf("auth: load ceremony: %w", err)
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
	if err != nil {
		return fmt.Errorf("auth: delete ceremony: %w", err)
	}

	return nil
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
		return "", fmt.Errorf("auth: create session: %w", err)
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
		return nil, fmt.Errorf("auth: load session: %w", err)
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
	if err != nil {
		return fmt.Errorf("auth: delete session: %w", err)
	}

	return nil
}

// RevokeUser signs userID out everywhere and clears every registered
// passkey, without deleting the account itself — they have to register a
// new passkey from scratch to get back in, same as BeginRegistration
// reclaiming an abandoned one. Also revokes every API token: "signed out
// everywhere" has to mean everywhere a request can authenticate as this
// user, not just the session-cookie path.
func (s *Store) RevokeUser(ctx context.Context, userID []byte) error {
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET credentials_json = '[]' WHERE id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: clear credentials: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM credential_metadata WHERE user_id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: delete credential metadata: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: delete sessions: %w", err)
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE user_id = ?`, encodeID(userID))
	if err != nil {
		return fmt.Errorf("auth: delete api tokens: %w", err)
	}

	return nil
}

// DeleteUser removes the account and every session it holds — irreversible,
// and the caller's job to also clean up anything outside this store (saved
// forge credentials, a running dashboard refresh).
func (s *Store) DeleteUser(ctx context.Context, userID []byte) error {
	if _, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: delete sessions: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE user_id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: delete api tokens: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM credential_metadata WHERE user_id = ?`, encodeID(userID)); err != nil {
		return fmt.Errorf("auth: delete credential metadata: %w", err)
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, encodeID(userID))
	if err != nil {
		return fmt.Errorf("auth: delete user: %w", err)
	}

	return nil
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
// labeled label, valid until expiresAt (#356 — mandatory, no "never
// expires" option; the caller, internal/api's handler, enforces the
// future/366-day-cap validation before this is ever called). raw is the
// only time the actual credential is ever returned — only its hash is
// stored, so losing it means generating a new one, the same "show once"
// handling a real secret needs.
func (s *Store) CreateAPIToken(ctx context.Context, userID []byte, label string, expiresAt time.Time) (raw string, tok *APIToken, err error) {
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
		ExpiresAt: expiresAt.UTC(),
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO api_tokens (id, user_id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
		tok.ID, encodeID(userID), label, hashAPIToken(raw), tok.CreatedAt, tok.ExpiresAt,
	)
	if err != nil {
		return "", nil, fmt.Errorf("auth: create api token: %w", err)
	}

	return raw, tok, nil
}

// ListAPITokens returns userID's own live tokens, oldest first.
func (s *Store) ListAPITokens(ctx context.Context, userID []byte) ([]*APIToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, label, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at, id`,
		encodeID(userID),
	)
	if err != nil {
		return nil, fmt.Errorf("auth: list api tokens: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var tokens []*APIToken
	for rows.Next() {
		var (
			tok        APIToken
			expiresAt  sql.NullTime
			lastUsedAt sql.NullTime
		)
		if err := rows.Scan(&tok.ID, &tok.Label, &tok.CreatedAt, &expiresAt, &lastUsedAt); err != nil {
			return nil, fmt.Errorf("auth: scan api token row: %w", err)
		}
		// expiresAt.Valid is false only for a row predating this column
		// (see APIToken.ExpiresAt's own doc comment) — the zero Time it
		// defaults to reads as "already expired," not "never expires."
		if expiresAt.Valid {
			tok.ExpiresAt = expiresAt.Time
		}
		if lastUsedAt.Valid {
			t := lastUsedAt.Time
			tok.LastUsedAt = &t
		}
		tokens = append(tokens, &tok)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list api tokens: %w", err)
	}

	return tokens, nil
}

// UserForAPIToken returns the user raw belongs to, or ErrNotFound — the
// Bearer-token equivalent of UserForSession. An expired token (or a
// legacy row with no recorded expiry at all — see APIToken.ExpiresAt)
// is rejected the same way an unknown one is, not a distinct error a
// caller could special-case into still trusting it (#356). Also records
// this as the token's most recent use, best-effort: a failure to
// persist that doesn't fail a request the token has already
// authenticated.
func (s *Store) UserForAPIToken(ctx context.Context, raw string) (*User, error) {
	hash := hashAPIToken(raw)
	var userIDStr string
	var expiresAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT user_id, expires_at FROM api_tokens WHERE token_hash = ?`, hash).Scan(&userIDStr, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("auth: load api token: %w", err)
	}
	if !expiresAt.Valid || time.Now().After(expiresAt.Time) {
		return nil, ErrNotFound
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
	if err != nil {
		return fmt.Errorf("auth: delete api token: %w", err)
	}

	return nil
}

// hashInviteToken is invites' own version of hashAPIToken — same
// operation (SHA-256 hex, safe against a leaked database dump for the
// same reason: the input is already a uniformly random 256-bit secret,
// never a human-chosen value), kept as its own function rather than
// sharing api_tokens' so each domain's hashing stays self-contained, the
// same way each already has its own token-generation code.
func hashInviteToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))

	return hex.EncodeToString(sum[:])
}

// CreateInvite generates a brand-new single-use registration invite for
// username/displayName, issued by createdBy (an admin's own user ID),
// valid for ttl. raw is the only time the actual token is ever returned —
// only its hash is stored, so a leaked database dump can't be replayed
// into a registration (the same reasoning CreateAPIToken's own doc
// comment gives).
func (s *Store) CreateInvite(ctx context.Context, username, displayName string, createdBy []byte, ttl time.Duration) (raw string, invite *Invite, err error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return "", nil, fmt.Errorf("auth: generate invite token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(secret)
	hash := hashInviteToken(raw)

	invite = &Invite{
		ID:          hash,
		Username:    username,
		DisplayName: displayName,
		CreatedBy:   createdBy,
		ExpiresAt:   time.Now().UTC().Add(ttl),
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO invites (token_hash, username, display_name, created_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
		hash, username, displayName, encodeID(createdBy), invite.ExpiresAt,
	)
	if err != nil {
		return "", nil, fmt.Errorf("auth: create invite: %w", err)
	}

	return raw, invite, nil
}

// ConsumeInviteIfValid atomically checks that token hashes to an
// outstanding (unconsumed, unexpired) invite issued for exactly username,
// and marks it consumed in the same statement — a single UPDATE with
// every validity condition in its WHERE clause, so a concurrent attempt to
// spend the same token twice can never both succeed: SQLite serializes
// writes, and only the first one actually matches consumed_at IS NULL.
// Returns ErrNotFound uniformly for an unknown token, a username
// mismatch, an already-consumed invite, or an expired one — deliberately
// not distinguishing which, the same "don't leak which check failed"
// reasoning ErrInvalidInvite's own doc comment gives at the Service layer
// that wraps this.
func (s *Store) ConsumeInviteIfValid(ctx context.Context, token, username string) (*Invite, error) {
	hash := hashInviteToken(token)
	now := time.Now().UTC()

	res, err := s.db.ExecContext(ctx,
		`UPDATE invites SET consumed_at = ? WHERE token_hash = ? AND username = ? AND consumed_at IS NULL AND expires_at > ?`,
		now, hash, username, now,
	)
	if err != nil {
		return nil, fmt.Errorf("auth: consume invite: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("auth: consume invite: %w", err)
	}
	if affected == 0 {
		return nil, ErrNotFound
	}

	row := s.db.QueryRowContext(ctx,
		`SELECT token_hash, username, display_name, created_by, expires_at, consumed_at FROM invites WHERE token_hash = ?`,
		hash,
	)

	return scanInvite(row)
}

// ListOutstandingInvites returns every invite that's neither consumed nor
// expired, soonest-expiring first — for the admin area's own list.
func (s *Store) ListOutstandingInvites(ctx context.Context) ([]*Invite, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT token_hash, username, display_name, created_by, expires_at, consumed_at
		 FROM invites WHERE consumed_at IS NULL AND expires_at > ? ORDER BY expires_at`,
		time.Now().UTC(),
	)
	if err != nil {
		return nil, fmt.Errorf("auth: list outstanding invites: %w", err)
	}
	defer func() { _ = rows.Close() }()

	var invites []*Invite
	for rows.Next() {
		inv, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		invites = append(invites, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list outstanding invites: %w", err)
	}

	return invites, nil
}

// RevokeInvite marks id (an invite's own ID — its stored token_hash, from
// CreateInvite/ListOutstandingInvites, never the raw token) consumed so
// it can never be used to register — the row itself is kept, the same
// "lingers, but harmlessly" trade-off design.md accepts for a genuinely
// consumed invite, rather than a DELETE. Unlike DeleteAPIToken's own
// idempotent delete, revoking an id that's already gone, already
// consumed, or was never issued is ErrNotFound, not a silent no-op: an
// admin revoking from a list they're looking at should be told when the
// row they clicked isn't outstanding anymore, rather than have the button
// silently do nothing.
func (s *Store) RevokeInvite(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE invites SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`,
		time.Now().UTC(), id,
	)
	if err != nil {
		return fmt.Errorf("auth: revoke invite: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("auth: revoke invite: %w", err)
	}
	if affected == 0 {
		return ErrNotFound
	}

	return nil
}

func scanInvite(row rowScanner) (*Invite, error) {
	var (
		hash, username, displayName, createdByStr string
		expiresAt                                 time.Time
		consumedAt                                sql.NullTime
	)
	if err := row.Scan(&hash, &username, &displayName, &createdByStr, &expiresAt, &consumedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}

		return nil, fmt.Errorf("auth: scan invite row: %w", err)
	}

	createdBy, err := decodeID(createdByStr)
	if err != nil {
		return nil, err
	}

	inv := &Invite{
		ID:          hash,
		Username:    username,
		DisplayName: displayName,
		CreatedBy:   createdBy,
		ExpiresAt:   expiresAt,
	}
	if consumedAt.Valid {
		t := consumedAt.Time
		inv.ConsumedAt = &t
	}

	return inv, nil
}

// RequestLogRow is one outbound-forge-request record, in the plain,
// dependency-free shape this store persists and returns — internal/
// requestlog owns the richer Entry type callers actually work with
// (dashboard.Forge, a typed rate-limit struct) and translates to/from
// this shape at its own SQLiteRecorder boundary, rather than this store
// importing internal/requestlog's types directly: internal/requestlog
// already depends on this package (its SQLiteRecorder wraps *Store), so
// the reverse import would be a cycle.
type RequestLogRow struct {
	ID         int64
	LoggedAt   time.Time
	Forge      string
	AccountID  string // "" when no per-account credential made this request
	Method     string
	Endpoint   string
	StatusCode int    // 0 when the request never got a response at all
	Outcome    string // "success" or a dashboard.ForgeErrorKind string
	// RateLimitLimit/RateLimitRemaining/RateLimitResetsAt/RateLimitCost
	// are all nil when the response carried no rate-limit fields at all —
	// not every request reports these, and a zero would misread as a
	// real, reported zero-remaining budget.
	RateLimitLimit     *int
	RateLimitRemaining *int
	RateLimitResetsAt  *time.Time
	RateLimitCost      *int
}

// RequestLogFilter narrows ListRequests. A zero Filter (both fields
// empty) returns every row.
type RequestLogFilter struct {
	Forge     string
	AccountID string
}

// RecordRequest persists row, then deletes the oldest rows past
// maxEntries in the same transaction — the caller
// (internal/requestlog.SQLiteRecorder) owns the retention cap, not this
// store, so changing it needs no change here.
func (s *Store) RecordRequest(ctx context.Context, row RequestLogRow, maxEntries int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("auth: record request: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	accountID := sql.NullString{String: row.AccountID, Valid: row.AccountID != ""}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO request_log (
			logged_at, forge, account_id, method, endpoint, status_code, outcome,
			rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.LoggedAt, row.Forge, accountID, row.Method, row.Endpoint, nullableInt(row.StatusCode), row.Outcome,
		row.RateLimitLimit, row.RateLimitRemaining, row.RateLimitResetsAt, row.RateLimitCost,
	)
	if err != nil {
		return fmt.Errorf("auth: record request: insert: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		DELETE FROM request_log WHERE id NOT IN (
			SELECT id FROM request_log ORDER BY id DESC LIMIT ?
		)`, maxEntries,
	)
	if err != nil {
		return fmt.Errorf("auth: record request: trim: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("auth: record request: commit: %w", err)
	}

	return nil
}

// nullableInt reports statusCode as unset (NULL) rather than a stored 0
// — a request that never got a response at all (RequestLogRow.StatusCode's
// own zero value) shouldn't read back as "status 0," a code no real
// response ever carries.
func nullableInt(statusCode int) sql.NullInt64 {
	if statusCode == 0 {
		return sql.NullInt64{}
	}

	return sql.NullInt64{Int64: int64(statusCode), Valid: true}
}

// ListRequests returns every row matching filter, newest first. An empty
// Filter field means "don't filter on this." Never returns a nil slice
// for an empty result — an empty, non-nil one — so a caller can range
// over it with no nil check.
func (s *Store) ListRequests(ctx context.Context, filter RequestLogFilter) ([]RequestLogRow, error) {
	query := `
		SELECT id, logged_at, forge, account_id, method, endpoint, status_code, outcome,
		       rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost
		FROM request_log WHERE 1=1`
	var args []any
	if filter.Forge != "" {
		query += " AND forge = ?"
		args = append(args, filter.Forge)
	}
	if filter.AccountID != "" {
		query += " AND account_id = ?"
		args = append(args, filter.AccountID)
	}
	query += " ORDER BY id DESC"

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("auth: list requests: %w", err)
	}
	defer func() { _ = rows.Close() }()

	out := []RequestLogRow{}
	for rows.Next() {
		var (
			row       RequestLogRow
			accountID sql.NullString
			status    sql.NullInt64
		)
		if err := rows.Scan(
			&row.ID, &row.LoggedAt, &row.Forge, &accountID, &row.Method, &row.Endpoint, &status, &row.Outcome,
			&row.RateLimitLimit, &row.RateLimitRemaining, &row.RateLimitResetsAt, &row.RateLimitCost,
		); err != nil {
			return nil, fmt.Errorf("auth: scan request log row: %w", err)
		}
		row.AccountID = accountID.String
		row.StatusCode = int(status.Int64)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("auth: list requests: %w", err)
	}

	return out, nil
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
