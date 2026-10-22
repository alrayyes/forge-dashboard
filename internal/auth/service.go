package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// initialCredentialLabel is what the very first passkey on a brand-new
// account is labeled — #355's required-nickname prompt only applies to
// BeginAddCredential's own flow (a user who already has one deciding to
// add another); account creation's own signup form isn't part of this
// feature's scope, so its one credential gets a sensible default rather
// than an empty label with nothing to show in Settings' own list.
const initialCredentialLabel = "Initial passkey"

// ceremonyTTL bounds how long a registration or login ceremony can sit
// unfinished — long enough for a passkey prompt, short enough that a
// stale one isn't sitting in the database forever.
const ceremonyTTL = 5 * time.Minute

// SessionTTL is how long an issued session stays valid.
const SessionTTL = 30 * 24 * time.Hour

const (
	kindRegister = "register"
	kindLogin    = "login"
)

// Service drives WebAuthn registration and login ceremonies against the
// configured relying party, persisting every step through Store.
type Service struct {
	webauthn *webauthn.WebAuthn
	store    *Store
}

// NewService returns a Service.
func NewService(wa *webauthn.WebAuthn, store *Store) *Service {
	return &Service{webauthn: wa, store: store}
}

// BeginRegistration starts a registration ceremony for username on an
// instance nobody has registered on yet. An instance has one owner, so once
// any user holds a passkey this returns ErrRegistrationClosed, whatever the
// username. A user row with no passkey (a first registration begun and never
// finished) doesn't count: it is reclaimed here.
func (s *Service) BeginRegistration(ctx context.Context, username, displayName string) (*protocol.CredentialCreation, error) {
	registered, err := s.store.HasAnyRegisteredUser(ctx)
	if err != nil {
		return nil, err
	}
	if registered {
		return nil, ErrRegistrationClosed
	}

	// A registration was begun and never finished, a page reload before the
	// passkey prompt completed, say. Nothing was ever attached to that
	// username, so it is free to reclaim rather than a dead end.
	if err := s.store.DeleteUnregisteredUser(ctx, username); err != nil {
		return nil, err
	}

	// A real user row from the first step, not a throwaway in-memory
	// stand-in — WebAuthnID has to be genuinely random and BeginRegistration
	// only reads from the User interface, so creating it now (rather than
	// after the ceremony finishes) means FinishRegistration has a real,
	// already-persisted ID to attach the credential to.
	u, err := s.store.CreateUser(ctx, username, displayName)
	if err != nil {
		return nil, err
	}

	creation, session, err := s.webauthn.BeginRegistration(u)
	if err != nil {
		return nil, fmt.Errorf("auth: begin registration: %w", err)
	}
	if err := s.store.SaveCeremony(ctx, username, kindRegister, *session, ceremonyTTL); err != nil {
		return nil, err
	}

	return creation, nil
}

// FinishRegistration completes a registration ceremony begun for
// username, attaching the new passkey to the account BeginRegistration
// already created.
func (s *Service) FinishRegistration(ctx context.Context, username string, r *http.Request) (*User, error) {
	session, err := s.store.LoadCeremony(ctx, username, kindRegister)
	if err != nil {
		return nil, err
	}
	defer func() { _ = s.store.DeleteCeremony(ctx, username, kindRegister) }()

	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}

	cred, err := s.webauthn.FinishRegistration(u, session, r)
	if err != nil {
		return nil, fmt.Errorf("auth: finish registration: %w", err)
	}
	// The first passkey on an instance is first-wins: two ceremonies that
	// finish together can't both register an owner.
	if err := s.store.AddFirstCredential(ctx, u.ID, *cred); err != nil {
		return nil, err
	}
	if err := s.store.SetCredentialLabel(ctx, u.ID, cred.ID, initialCredentialLabel); err != nil {
		return nil, err
	}
	u.Credentials = append(u.Credentials, *cred)

	return u, nil
}

// BeginAddCredential starts a registration ceremony for an additional
// passkey on u's already-authenticated account (#355) — the same
// underlying WebAuthn ceremony BeginRegistration drives for a brand-new
// account, but against a user that already exists and, critically,
// already has credentials: the library's own excludeCredentials (built
// from u.WebAuthnCredentials()) is what stops a browser from letting
// someone re-register the same authenticator as a second, redundant
// entry.
func (s *Service) BeginAddCredential(ctx context.Context, u *User) (*protocol.CredentialCreation, error) {
	creation, session, err := s.webauthn.BeginRegistration(u)
	if err != nil {
		return nil, fmt.Errorf("auth: begin add credential: %w", err)
	}
	if err := s.store.SaveCeremony(ctx, u.Username, kindRegister, *session, ceremonyTTL); err != nil {
		return nil, err
	}

	return creation, nil
}

// FinishAddCredential completes a ceremony BeginAddCredential started,
// attaching a new passkey labeled label to u's account. label is
// required — #355's whole point is that a nickname is prompted for at
// registration time, not derived from the authenticator.
func (s *Service) FinishAddCredential(ctx context.Context, u *User, label string, r *http.Request) (*Credential, error) {
	session, err := s.store.LoadCeremony(ctx, u.Username, kindRegister)
	if err != nil {
		return nil, err
	}
	defer func() { _ = s.store.DeleteCeremony(ctx, u.Username, kindRegister) }()

	cred, err := s.webauthn.FinishRegistration(u, session, r)
	if err != nil {
		return nil, fmt.Errorf("auth: finish add credential: %w", err)
	}
	if err := s.store.AddCredential(ctx, u.ID, *cred); err != nil {
		return nil, err
	}
	createdAt := time.Now().UTC()
	if err := s.store.setCredentialLabelAt(ctx, u.ID, cred.ID, label, createdAt); err != nil {
		return nil, err
	}

	return &Credential{ID: credentialIDKey(cred.ID), Label: label, CreatedAt: createdAt}, nil
}

// BeginLogin starts a login ceremony for an existing username.
func (s *Service) BeginLogin(ctx context.Context, username string) (*protocol.CredentialAssertion, error) {
	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if len(u.Credentials) == 0 {
		// An abandoned registration (BeginRegistration reclaims these on
		// retry) — nothing to log in with, which to a caller is the same
		// signal as no account at all.
		return nil, ErrNotFound
	}

	assertion, session, err := s.webauthn.BeginLogin(u)
	if err != nil {
		return nil, fmt.Errorf("auth: begin login: %w", err)
	}
	if err := s.store.SaveCeremony(ctx, username, kindLogin, *session, ceremonyTTL); err != nil {
		return nil, err
	}

	return assertion, nil
}

// FinishLogin completes a login ceremony, persisting the authenticator's
// bumped signature counter so a cloned authenticator is caught on a later
// login.
func (s *Service) FinishLogin(ctx context.Context, username string, r *http.Request) (*User, error) {
	session, err := s.store.LoadCeremony(ctx, username, kindLogin)
	if err != nil {
		return nil, err
	}
	defer func() { _ = s.store.DeleteCeremony(ctx, username, kindLogin) }()

	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}

	cred, err := s.webauthn.FinishLogin(u, session, r)
	if err != nil {
		return nil, fmt.Errorf("auth: finish login: %w", err)
	}
	if err := s.store.UpdateCredential(ctx, u.ID, *cred); err != nil {
		return nil, err
	}

	return u, nil
}

// CreateSession issues a session token for u, ready to set as a cookie.
func (s *Service) CreateSession(ctx context.Context, u *User) (token string, err error) {
	return s.store.CreateSession(ctx, u.ID, SessionTTL)
}

// HasAnyRegisteredUser reports whether any account has completed
// registration — an exported wrapper around the Store method of the same
// name, reachable from outside this package for the public
// registration-status endpoint.
func (s *Service) HasAnyRegisteredUser(ctx context.Context) (bool, error) {
	return s.store.HasAnyRegisteredUser(ctx)
}
