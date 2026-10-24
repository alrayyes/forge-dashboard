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
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/singleuser"
	"github.com/go-webauthn/webauthn/webauthn"
	"modernc.org/sqlite"
	sqlitelib "modernc.org/sqlite/lib"
)

// errCredentialNotFound is what removing a passkey the user doesn't have answers.
var errCredentialNotFound = errors.New("no such credential")

// ErrNotFound is returned by a lookup that found nothing — a sentinel
// rather than a typed error, since every caller only ever needs to know
// which kind, not reach anything out of it.
var ErrNotFound = errors.New("auth: not found")

// ErrRegistrationClosed is returned when a first registration finishes after
// another user already holds a passkey. An instance has one owner, and the
// first passkey to land is theirs.
var ErrRegistrationClosed = errors.New("auth: registration is closed")

// ErrUsernameTaken is what CreateUser answers when the username already
// belongs to a row, as when another request created the owner's first.
var ErrUsernameTaken = errors.New("auth: username taken")

// maxPendingCeremonies bounds the unfinished ceremonies kept per kind. Anyone
// can begin one, so the table can't be allowed to grow with the traffic.
const maxPendingCeremonies = 100

// Store persists users, their passkey credentials, in-flight WebAuthn
// ceremonies, and sessions. It owns no driver of its own — cmd wires up
// whichever database/sql driver is registered (modernc.org/sqlite) and
// hands Store a plain *sql.DB.
type Store struct {
	db *sql.DB

	// registrationMu serialises claiming the owner's row and writing the first
	// passkey, the two read-then-write steps of a registration.
	registrationMu sync.Mutex
}

// NewStore wraps db. Init must be called once before any other method.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// schema is the auth tables, each created only if missing.
const schema = `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		username TEXT NOT NULL UNIQUE,
		display_name TEXT NOT NULL,
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
		expires_at TIMESTAMP NOT NULL,
		created_at TIMESTAMP NOT NULL
	);

	CREATE TABLE IF NOT EXISTS api_tokens (
		id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		created_at TIMESTAMP NOT NULL,
		expires_at TIMESTAMP,
		last_used_at TIMESTAMP
	);

	CREATE TABLE IF NOT EXISTS credential_metadata (
		credential_id TEXT PRIMARY KEY,
		label TEXT NOT NULL,
		created_at TIMESTAMP NOT NULL
	);

	CREATE TABLE IF NOT EXISTS request_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		logged_at TIMESTAMP NOT NULL,
		forge TEXT NOT NULL,
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

// Init creates the schema if it doesn't already exist. Safe to call every
// startup.
func (s *Store) Init(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("auth: create schema: %w", err)
	}

	if err := s.addColumnsIfMissing(ctx); err != nil {
		return err
	}

	return s.dropInviteMachinery(ctx)
}

// dropInviteMachinery removes what invites and the admin flag left in a
// database created before an instance became single-user: the invites table
// and users.is_admin. Safe on every start: a database without them is left
// alone. is_admin is a plain column with no key or index, so DROP COLUMN works.
func (s *Store) dropInviteMachinery(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `DROP TABLE IF EXISTS invites`); err != nil {
		return fmt.Errorf("auth: drop invites table: %w", err)
	}

	var hasColumn int
	err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM pragma_table_info('users') WHERE name = 'is_admin'`).Scan(&hasColumn)
	if err != nil {
		return fmt.Errorf("auth: look for users.is_admin: %w", err)
	}
	if hasColumn == 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE users DROP COLUMN is_admin`); err != nil {
		return fmt.Errorf("auth: drop users.is_admin: %w", err)
	}

	return nil
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
func (s *Store) CreateUser(ctx context.Context, username, displayName string) (*User, error) {
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return nil, fmt.Errorf("auth: generate user id: %w", err)
	}

	u := &User{
		ID:          id,
		Username:    username,
		DisplayName: displayName,
		Credentials: []webauthn.Credential{},
		CreatedAt:   time.Now().UTC(),
	}

	credsJSON, err := json.Marshal(u.Credentials)
	if err != nil {
		return nil, fmt.Errorf("auth: encode credentials: %w", err)
	}

	_, err = s.db.ExecContext(ctx,
		`INSERT INTO users (id, username, display_name, credentials_json, created_at) VALUES (?, ?, ?, ?, ?)`,
		encodeID(id), username, displayName, string(credsJSON), u.CreatedAt,
	)
	if isUniqueViolation(err) {
		return nil, ErrUsernameTaken
	}
	if err != nil {
		return nil, fmt.Errorf("auth: insert user: %w", err)
	}

	return u, nil
}

// isUniqueViolation reports whether err is the driver's unique or primary key
// constraint error, by its code rather than its wording.
func isUniqueViolation(err error) bool {
	var se *sqlite.Error
	if !errors.As(err, &se) {
		return false
	}

	return se.Code() == sqlitelib.SQLITE_CONSTRAINT_UNIQUE || se.Code() == sqlitelib.SQLITE_CONSTRAINT_PRIMARYKEY
}

// ClaimUnregisteredUser returns the account a registration under username
// attaches its passkey to. An instance has one owner, so a row with no
// passkey is that owner's: either a first registration begun and never
// finished, or an owner whose passkeys the operator cleared. Both keep the
// row, and so its id, which the saved settings and the webhook token hang
// off, and takes this attempt's display name. The username changes only when
// a ceremony wins (AddFirstCredential), so ceremonies that race can't break
// each other's lookup. Any other passkey-less row created before olderThan
// is an abandoned attempt whose ceremony has expired, so nothing can finish
// it and it goes; a newer one may still be mid-ceremony and stays. Without a
// passkey-less row a new one is created.
func (s *Store) ClaimUnregisteredUser(ctx context.Context, username, displayName string, olderThan time.Time) (*User, error) {
	// Registrations that begin together take turns, so the second finds the
	// row the first created and shares it instead of racing it for the name.
	s.registrationMu.Lock()
	defer s.registrationMu.Unlock()

	u, err := s.claimOrCreate(ctx, username, displayName, olderThan)
	if errors.Is(err, ErrUsernameTaken) {
		// No passkey-less row exists, yet the name is held: a registered owner
		// has it, so the registration is closed.
		return nil, ErrRegistrationClosed
	}

	return u, err
}

func (s *Store) claimOrCreate(ctx context.Context, username, displayName string, olderThan time.Time) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("auth: begin claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Take the write lock before reading. A transaction that reads first holds a
	// snapshot, and a ceremony saved since makes its upgrade to a write fail
	// at once with SQLITE_BUSY, which the busy timeout doesn't retry.
	if _, err := tx.ExecContext(ctx, `UPDATE users SET id = id WHERE 0`); err != nil {
		return nil, fmt.Errorf("auth: lock for claim: %w", err)
	}

	var id string
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM users WHERE credentials_json = '[]' `+OwnerOrder,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("auth: commit claim: %w", err)
		}

		return s.CreateUser(ctx, username, displayName)
	}
	if err != nil {
		return nil, fmt.Errorf("auth: find the unregistered user: %w", err)
	}
	const abandoned = `FROM users WHERE credentials_json = '[]' AND id != ? AND created_at < ?`
	if _, err := tx.ExecContext(ctx, `DELETE `+abandoned, id, olderThan.UTC()); err != nil {
		return nil, fmt.Errorf("auth: drop abandoned registrations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET display_name = ? WHERE id = ?`, displayName, id); err != nil {
		return nil, fmt.Errorf("auth: claim the unregistered user: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("auth: commit claim: %w", err)
	}

	raw, err := decodeID(id)
	if err != nil {
		return nil, err
	}

	return s.userByID(ctx, raw)
}

// GetUserByUsername returns ErrNotFound when no such user is registered.
func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, display_name, credentials_json, created_at FROM users WHERE username = ?`,
		username,
	)

	return scanUser(row)
}

// userByID returns ErrNotFound when no such user is registered. id is the raw
// WebAuthn user handle, the same bytes User.ID holds. Only a registration
// ceremony names its row this way; everything else acts for the owner.
func (s *Store) userByID(ctx context.Context, id []byte) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, display_name, credentials_json, created_at FROM users WHERE id = ?`,
		encodeID(id),
	)

	return scanUser(row)
}

// HasAnyRegisteredUser reports whether any account has completed
// registration — a row with no credentials (BeginRegistration begun,
// never finished) doesn't count. Once it is true, registration is closed.
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

// OwnerOrder is the tail of every query that picks the instance's one user: the
// oldest user holding a passkey, the rule the single-user cleanup keeps by, and
// with none the oldest row (an abandoned registration). The settings and auth
// migrations build their owner query from it too, so the user whose rows
// survive the upgrade is the user Owner returns.
const OwnerOrder = `ORDER BY credentials_json = '[]', created_at, rowid LIMIT 1`

// Owner returns the instance's one user (see OwnerOrder), or ErrNotFound on an
// instance nobody has started registering on.
func (s *Store) Owner(ctx context.Context) (*User, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, username, display_name, credentials_json, created_at FROM users `+OwnerOrder,
	)

	return scanUser(row)
}

// ResetResult says what ResetPasskeys removed.
type ResetResult struct {
	Username string
	Passkeys int
	Sessions int
	Tokens   int
}

// ResetPasskeys is the operator's way back in after the only passkey is lost.
// It clears the owner's passkeys and signs every session out, in one
// transaction, and keeps the user row, so the passkey registered next attaches
// to it. The settings tables hold no user and are untouched. API tokens stay
// unless withTokens, since they are separate secrets the lost authenticator
// never protected. With no passkey the instance is open to the first
// registration again (ClaimUnregisteredUser
// attaches it to this row).
func (s *Store) ResetPasskeys(ctx context.Context, withTokens bool) (ResetResult, error) {
	owner, err := s.Owner(ctx)
	if err != nil {
		return ResetResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ResetResult{}, fmt.Errorf("auth: begin reset: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	id := encodeID(owner.ID)
	res := ResetResult{Username: owner.Username, Passkeys: len(owner.Credentials)}

	if _, err := tx.ExecContext(ctx, `UPDATE users SET credentials_json = '[]' WHERE id = ?`, id); err != nil {
		return ResetResult{}, fmt.Errorf("auth: clear passkeys: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM credential_metadata`); err != nil {
		return ResetResult{}, fmt.Errorf("auth: clear passkey labels: %w", err)
	}
	// Every ceremony in flight belongs to the passkeys just cleared or to a
	// registration that predates the reset.
	if _, err := tx.ExecContext(ctx, `DELETE FROM ceremonies`); err != nil {
		return ResetResult{}, fmt.Errorf("auth: clear ceremonies: %w", err)
	}

	if res.Sessions, err = deleteCount(ctx, tx, `DELETE FROM sessions`); err != nil {
		return ResetResult{}, fmt.Errorf("auth: clear sessions: %w", err)
	}
	if withTokens {
		if res.Tokens, err = deleteCount(ctx, tx, `DELETE FROM api_tokens`); err != nil {
			return ResetResult{}, fmt.Errorf("auth: clear API tokens: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return ResetResult{}, fmt.Errorf("auth: commit reset: %w", err)
	}

	return res, nil
}

func deleteCount(ctx context.Context, tx *sql.Tx, query string, args ...any) (int, error) {
	r, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err //nolint:wrapcheck // callers add the table
	}
	n, err := r.RowsAffected()

	return int(n), err
}

// rowScanner is the common surface of *sql.Row and *sql.Rows that scanUser
// needs.
type rowScanner interface {
	Scan(dest ...any) error
}

func scanUser(row rowScanner) (*User, error) {
	var (
		idStr, credsJSON string
		u                User
	)
	if err := row.Scan(&idStr, &u.Username, &u.DisplayName, &credsJSON, &u.CreatedAt); err != nil {
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

	if err := json.Unmarshal([]byte(credsJSON), &u.Credentials); err != nil {
		return nil, fmt.Errorf("auth: decode stored credentials: %w", err)
	}

	return &u, nil
}

// AddCredential appends cred to the owner's stored credentials — a brand-new
// passkey, from a just-finished registration ceremony.
func (s *Store) AddCredential(ctx context.Context, cred webauthn.Credential) error {
	u, err := s.Owner(ctx)
	if err != nil {
		return err
	}
	u.Credentials = append(u.Credentials, cred)

	return s.saveCredentials(ctx, u)
}

// AddFirstCredential attaches the passkey of a registration that began on an
// instance with no registered user. It is first-wins: the write happens only
// while no other user holds a passkey, decided by the same statement that
// writes it, so two ceremonies finishing together cannot both succeed. The
// loser gets ErrRegistrationClosed and its pending user row is removed.
func (s *Store) AddFirstCredential(ctx context.Context, userID []byte, cred webauthn.Credential) error {
	credsJSON, err := json.Marshal([]webauthn.Credential{cred})
	if err != nil {
		return fmt.Errorf("auth: encode credentials: %w", err)
	}

	s.registrationMu.Lock()
	defer s.registrationMu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("auth: begin first registration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	id := encodeID(userID)
	// Passkey-less rows other than this one are abandoned attempts. They go
	// first so none can hold the username this registration takes. If this
	// row is itself gone (another ceremony won and cleared it), the update
	// below matches nothing and the registration is refused.
	const abandoned = `FROM users WHERE id != ? AND credentials_json = '[]'
		  AND EXISTS (SELECT 1 FROM users WHERE id = ? AND credentials_json = '[]')`
	if _, err := tx.ExecContext(ctx, `DELETE `+abandoned, id, id); err != nil {
		return fmt.Errorf("auth: clear abandoned registrations: %w", err)
	}
	res, err := tx.ExecContext(ctx, `
		UPDATE users SET credentials_json = ?
		WHERE id = ? AND credentials_json = '[]'
		  AND NOT EXISTS (SELECT 1 FROM users WHERE id != ? AND credentials_json != '[]')`,
		string(credsJSON), id, id,
	)
	if err != nil {
		return fmt.Errorf("auth: save first credential: %w", err)
	}
	attached, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("auth: save first credential: %w", err)
	}
	if attached == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ? AND credentials_json = '[]'`, id); err != nil {
			return fmt.Errorf("auth: remove refused registration: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("auth: remove refused registration: %w", err)
		}

		return ErrRegistrationClosed
	}

	var kept string
	if err := tx.QueryRowContext(ctx, `SELECT username FROM users WHERE id = ?`, id).Scan(&kept); err != nil {
		return fmt.Errorf("auth: read the first registered user: %w", err)
	}
	if err := singleuser.WriteMarker(ctx, tx, kept, 0); err != nil {
		return fmt.Errorf("auth: record the first registration: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("auth: commit first registration: %w", err)
	}

	return nil
}

// UpdateCredential replaces the stored credential sharing cred's ID —
// FinishLogin bumps the authenticator's signature counter on every
// successful login, and that has to be persisted to catch a cloned
// authenticator on a later login.
func (s *Store) UpdateCredential(ctx context.Context, cred webauthn.Credential) error {
	u, err := s.Owner(ctx)
	if err != nil {
		return err
	}
	for i, existing := range u.Credentials {
		if string(existing.ID) == string(cred.ID) {
			u.Credentials[i] = cred

			return s.saveCredentials(ctx, u)
		}
	}

	return fmt.Errorf("auth: credential %x not found for user: %w", cred.ID, errCredentialNotFound)
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

// SetCredentialLabel names credID (a passkey of the owner) label — called
// once, right after AddCredential, for both the very first passkey a
// brand-new account registers and every one added afterward (#355), so
// Settings always has something to show even for an account that
// predates this feature having a UI of its own.
func (s *Store) SetCredentialLabel(ctx context.Context, credID []byte, label string) error {
	return s.setCredentialLabelAt(ctx, credID, label, time.Now().UTC())
}

// setCredentialLabelAt is SetCredentialLabel with an explicit createdAt
// — used by Service.FinishAddCredential so the timestamp it hands back
// to a caller in the same response matches exactly what got persisted,
// rather than a fresh time.Now() taken moments later disagreeing with
// it by however long the write itself took.
func (s *Store) setCredentialLabelAt(ctx context.Context, credID []byte, label string, createdAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO credential_metadata (credential_id, label, created_at)
		VALUES (?, ?, ?)
		ON CONFLICT (credential_id) DO UPDATE SET label = excluded.label`,
		credentialIDKey(credID), label, createdAt,
	)
	if err != nil {
		return fmt.Errorf("auth: set credential label: %w", err)
	}

	return nil
}

// ListCredentials returns the owner's passkeys, oldest first — driven
// by the account's real webauthn.Credential list (the source of truth
// for what can actually authenticate), not credential_metadata alone,
// so a credential somehow missing its label row still appears rather
// than silently vanishing from the list. defaultLabel fills that gap:
// a credential from before this feature existed reads back with no
// metadata row at all.
func (s *Store) ListCredentials(ctx context.Context) ([]*Credential, error) {
	u, err := s.Owner(ctx)
	if err != nil {
		return nil, err
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT credential_id, label, created_at FROM credential_metadata`,
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
// the owner's only remaining passkey — this app is WebAuthn-only with no
// password fallback, so deleting it would lock the account out
// entirely (#355).
var ErrLastCredential = errors.New("auth: can't remove the account's last remaining passkey")

// RemoveCredential deletes credID from the owner's account. Idempotent for an
// id that's unknown or already gone (matching DeleteAPIToken), but never for
// the account's last one: that's always
// ErrLastCredential, not silently skipped, so a caller (or a stale
// list somehow down to one) can't accidentally lock the account out.
func (s *Store) RemoveCredential(ctx context.Context, credID string) error {
	u, err := s.Owner(ctx)
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
	_, err = s.db.ExecContext(ctx, `DELETE FROM credential_metadata WHERE credential_id = ?`, credID)
	if err != nil {
		return fmt.Errorf("auth: delete credential metadata: %w", err)
	}

	return nil
}

// SaveCeremony records the in-flight WebAuthn session data under key, which
// the registration and login ceremonies set to their challenge: random, so one
// visitor's ceremony can't name or replace another's. (BeginAddCredential keys
// by username; the caller is signed in.) The pending ceremonies of a kind are
// bounded and expired ones are dropped. The table still calls the key column
// username, from when every ceremony was keyed by one.
func (s *Store) SaveCeremony(ctx context.Context, key, kind string, session webauthn.SessionData, ttl time.Duration) error {
	data, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("auth: encode ceremony session: %w", err)
	}
	// Expired ones can never finish, and past the bound the oldest goes first.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM ceremonies WHERE expires_at < ?`, time.Now().UTC()); err != nil {
		return fmt.Errorf("auth: prune expired ceremonies: %w", err)
	}
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM ceremonies WHERE kind = ? AND rowid IN (
			SELECT rowid FROM ceremonies WHERE kind = ? ORDER BY expires_at DESC LIMIT -1 OFFSET ?)`,
		kind, kind, maxPendingCeremonies-1,
	); err != nil {
		return fmt.Errorf("auth: bound pending ceremonies: %w", err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO ceremonies (username, kind, session_json, expires_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT (username, kind) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at`,
		key, kind, string(data), time.Now().UTC().Add(ttl),
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

// CreateSession issues a new opaque session token for the owner, valid for
// ttl.
func (s *Store) CreateSession(ctx context.Context, ttl time.Duration) (token string, err error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("auth: generate session token: %w", err)
	}
	token = base64.RawURLEncoding.EncodeToString(raw)

	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO sessions (token, expires_at, created_at) VALUES (?, ?, ?)`,
		token, now.Add(ttl), now,
	)
	if err != nil {
		return "", fmt.Errorf("auth: create session: %w", err)
	}

	return token, nil
}

// UserForSession returns the owner when token is a valid, unexpired session,
// or ErrNotFound.
func (s *Store) UserForSession(ctx context.Context, token string) (*User, error) {
	var expiresAt time.Time
	err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM sessions WHERE token = ?`, token).
		Scan(&expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("auth: load session: %w", err)
	}
	if time.Now().UTC().After(expiresAt) {
		return nil, ErrNotFound
	}

	return s.Owner(ctx)
}

// DeleteSession revokes a session token — logout, or the owner revoking
// one of their own sessions.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	if err != nil {
		return fmt.Errorf("auth: delete session: %w", err)
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

// CreateAPIToken generates a brand-new personal API token for the owner,
// labeled label, valid until expiresAt (#356 — mandatory, no "never
// expires" option; the caller, internal/api's handler, enforces the
// future/366-day-cap validation before this is ever called). raw is the
// only time the actual credential is ever returned — only its hash is
// stored, so losing it means generating a new one, the same "show once"
// handling a real secret needs.
func (s *Store) CreateAPIToken(ctx context.Context, label string, expiresAt time.Time) (raw string, tok *APIToken, err error) {
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
		`INSERT INTO api_tokens (id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tok.ID, label, hashAPIToken(raw), tok.CreatedAt, tok.ExpiresAt,
	)
	if err != nil {
		return "", nil, fmt.Errorf("auth: create api token: %w", err)
	}

	return raw, tok, nil
}

// ListAPITokens returns the owner's tokens, oldest first.
func (s *Store) ListAPITokens(ctx context.Context) ([]*APIToken, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, label, created_at, expires_at, last_used_at FROM api_tokens ORDER BY created_at, id`,
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

// UserForAPIToken returns the owner when raw is a valid token, or ErrNotFound — the
// Bearer-token equivalent of UserForSession. An expired token (or a
// legacy row with no recorded expiry at all — see APIToken.ExpiresAt)
// is rejected the same way an unknown one is, not a distinct error a
// caller could special-case into still trusting it (#356). Also records
// this as the token's most recent use, best-effort: a failure to
// persist that doesn't fail a request the token has already
// authenticated.
func (s *Store) UserForAPIToken(ctx context.Context, raw string) (*User, error) {
	hash := hashAPIToken(raw)
	var expiresAt sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT expires_at FROM api_tokens WHERE token_hash = ?`, hash).Scan(&expiresAt)
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

	return s.Owner(ctx)
}

// DeleteAPIToken revokes id. Idempotent: deleting one that's already gone is
// not an error.
func (s *Store) DeleteAPIToken(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("auth: delete api token: %w", err)
	}

	return nil
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

// RequestLogFilter narrows ListRequests. A zero Filter returns every row.
type RequestLogFilter struct {
	Forge string
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

	_, err = tx.ExecContext(ctx, `
		INSERT INTO request_log (
			logged_at, forge, method, endpoint, status_code, outcome,
			rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.LoggedAt, row.Forge, row.Method, row.Endpoint, nullableInt(row.StatusCode), row.Outcome,
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
		SELECT id, logged_at, forge, method, endpoint, status_code, outcome,
		       rate_limit_limit, rate_limit_remaining, rate_limit_resets_at, rate_limit_cost
		FROM request_log WHERE 1=1`
	var args []any
	if filter.Forge != "" {
		query += " AND forge = ?"
		args = append(args, filter.Forge)
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
			row    RequestLogRow
			status sql.NullInt64
		)
		if err := rows.Scan(
			&row.ID, &row.LoggedAt, &row.Forge, &row.Method, &row.Endpoint, &status, &row.Outcome,
			&row.RateLimitLimit, &row.RateLimitRemaining, &row.RateLimitResetsAt, &row.RateLimitCost,
		); err != nil {
			return nil, fmt.Errorf("auth: scan request log row: %w", err)
		}
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
