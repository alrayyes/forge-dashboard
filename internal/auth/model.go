// Package auth is passkey (WebAuthn) registration and login: no password
// ever stored or transmitted, a session cookie once a ceremony succeeds,
// and the store both ceremonies and sessions persist to (SQLite).
package auth

import (
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
)

// User is a registered account. It implements webauthn.User directly, so
// it can be handed straight to the library's Begin/Finish calls with no
// adapter.
type User struct {
	ID          []byte
	Username    string
	DisplayName string
	IsAdmin     bool
	Credentials []webauthn.Credential
	CreatedAt   time.Time
}

// WebAuthnID satisfies webauthn.User with the account's random handle.
func (u *User) WebAuthnID() []byte { return u.ID }

// WebAuthnName satisfies webauthn.User with the account's username.
func (u *User) WebAuthnName() string { return u.Username }

// WebAuthnDisplayName satisfies webauthn.User with the account's display name.
func (u *User) WebAuthnDisplayName() string { return u.DisplayName }

// WebAuthnCredentials satisfies webauthn.User with every passkey on file.
func (u *User) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

// Credential is one registered passkey's own display metadata (#355) —
// never the credential itself, which stays on the authenticator that
// created it and never reaches this server at all. ID is base64url of
// the underlying webauthn.Credential.ID, matching how a credential ID
// already appears everywhere else in a WebAuthn ceremony (excludeCredentials,
// allowCredentials) rather than inventing a second encoding.
type Credential struct {
	ID        string
	Label     string
	CreatedAt time.Time
}

// APIToken is a personal API token's own metadata — never the raw value,
// which only Store.CreateAPIToken ever returns, once, at creation time.
// Matches components.schemas.APIToken.
type APIToken struct {
	ID        string
	Label     string
	CreatedAt time.Time
	// ExpiresAt is always set (#356: mandatory at creation, no "never
	// expires" option) — UserForAPIToken rejects a token once this
	// passes, the same way it rejects one it's never heard of. A row
	// from before this field existed reads back as the zero Time, which
	// is always in the past, so it's rejected too rather than treated as
	// permanently valid just because the schema changed underneath it.
	ExpiresAt time.Time
	// LastUsedAt is nil until the token first authenticates a request —
	// the same "hasn't happened yet, not zero-value" shape
	// dashboard.RateLimit's own nilable fields use elsewhere in this
	// codebase.
	LastUsedAt *time.Time
}

// Invite is a single-use, admin-issued registration invite — the same
// "hashed secret, shown raw exactly once" shape APIToken already uses
// (design.md's explicit precedent). ID is the invite's own stored
// token_hash, never the raw token itself: SHA-256 of a uniformly random
// secret can't be reversed (the same reasoning hashAPIToken's own doc
// comment gives for api_tokens), so it's safe to hand back to a caller as
// a stable identifier — it's what ListOutstandingInvites/RevokeInvite key
// on, not something that can complete a registration on its own.
type Invite struct {
	ID          string
	Username    string
	DisplayName string
	// CreatedBy is the admin's own WebAuthn user handle — the same raw
	// bytes User.ID holds — not a display name, so it survives that
	// admin's own account being renamed (usernames have no such
	// guarantee elsewhere in this schema, but nothing renames a username
	// today either; matching User.ID's shape is just the safer default).
	CreatedBy []byte
	ExpiresAt time.Time
	// ConsumedAt is nil for an outstanding invite — set once by either a
	// completed registration (ConsumeInviteIfValid) or an admin's own
	// revoke (RevokeInvite), which share the same column since this
	// schema has no separate "revoked" state to track.
	ConsumedAt *time.Time
}
