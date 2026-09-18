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
