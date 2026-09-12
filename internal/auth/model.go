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
