package auth

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// InitialCredentialLabel is what the very first passkey on a brand-new
// account is labeled — #355's required-nickname prompt only applies to
// BeginAddCredential's own flow (a user who already has one deciding to
// add another); account creation's own signup form isn't part of this
// feature's scope, so its one credential gets a sensible default rather
// than an empty label with nothing to show in Settings' own list.
const InitialCredentialLabel = "Initial passkey"

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

// A first registration names its account itself: the instance has one user, so
// the visitor is asked for nothing.
const (
	newOwnerUsername    = "owner"
	newOwnerDisplayName = "Owner"
)

// residentKey makes every new passkey discoverable, stored on the device with
// the site and user, because login names no credential and so can only offer
// passkeys the device can find by itself. A security key otherwise keeps a
// non-resident credential, which sign-in without a username can't use.
var residentKey = webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired)

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

// BeginRegistration starts a registration ceremony for the owner of an
// instance nobody has registered on yet. An instance has one owner, so once
// any user holds a passkey this returns ErrRegistrationClosed. A user row with
// no passkey doesn't count: it is reused here.
func (s *Service) BeginRegistration(ctx context.Context) (*protocol.CredentialCreation, error) {
	registered, err := s.store.HasAnyRegisteredUser(ctx)
	if err != nil {
		return nil, err
	}
	if registered {
		return nil, ErrRegistrationClosed
	}

	// A row with no passkey is the owner's: a registration begun and never
	// finished, or the passkeys an operator cleared. It is reused, so what
	// hangs off its id survives. WebAuthnID has to be genuinely random and
	// BeginRegistration only reads the User interface, so the row exists from
	// this first step and FinishRegistration attaches to a persisted ID.
	u, err := s.store.ClaimUnregisteredUser(ctx, newOwnerUsername, newOwnerDisplayName, time.Now().Add(-ceremonyTTL))
	if err != nil {
		return nil, err
	}

	creation, session, err := s.webauthn.BeginRegistration(u, residentKey)
	if err != nil {
		return nil, fmt.Errorf("auth: begin registration: %w", err)
	}
	if err := s.store.SaveCeremony(ctx, session.Challenge, kindRegister, *session, ceremonyTTL); err != nil {
		return nil, err
	}

	return creation, nil
}

// FinishRegistration completes the registration ceremony BeginRegistration
// began, attaching the new passkey to the account BeginRegistration
// already created.
func (s *Service) FinishRegistration(ctx context.Context, r *http.Request) (*User, error) {
	parsed, err := parseCreation(r)
	if err != nil {
		return nil, err
	}
	// The ceremony is found by the challenge the authenticator signed. Only the
	// browser that began it holds that challenge, so a stranger's request
	// finds nothing and disturbs nothing.
	key := parsed.Response.CollectedClientData.Challenge
	session, err := s.store.LoadCeremony(ctx, key, kindRegister)
	if err != nil {
		return nil, err
	}
	defer func() { _ = s.store.DeleteCeremony(ctx, key, kindRegister) }()

	// The ceremony names the row: the owner's row may hold another username
	// until this registration wins.
	u, err := s.store.userByID(ctx, session.UserID)
	if err != nil {
		return nil, err
	}

	cred, err := s.webauthn.CreateCredential(u, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("auth: finish registration: %w", err)
	}
	// The first passkey on an instance is first-wins: two ceremonies that
	// finish together can't both register an owner.
	if err := s.store.AddFirstCredential(ctx, u.ID, *cred); err != nil {
		return nil, err
	}
	if err := s.store.SetCredentialLabel(ctx, cred.ID, InitialCredentialLabel); err != nil {
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
	creation, session, err := s.webauthn.BeginRegistration(u, residentKey)
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
	if err := s.store.AddCredential(ctx, *cred); err != nil {
		return nil, err
	}
	createdAt := time.Now().UTC()
	if err := s.store.setCredentialLabelAt(ctx, cred.ID, label, createdAt); err != nil {
		return nil, err
	}

	return &Credential{ID: credentialIDKey(cred.ID), Label: label, CreatedAt: createdAt}, nil
}

// BeginLogin starts a login ceremony for the owner. The options name no
// credential and no user: the browser offers whichever passkey for this site the
// device holds, so nothing is typed and nothing is revealed to a visitor. That
// only finds resident keys, which is why registration requires one.
func (s *Service) BeginLogin(ctx context.Context) (*protocol.CredentialAssertion, error) {
	u, err := s.store.Owner(ctx)
	if err != nil {
		return nil, err
	}
	if len(u.Credentials) == 0 {
		// An abandoned registration (BeginRegistration reclaims these on
		// retry) — nothing to log in with, which to a caller is the same
		// signal as no account at all.
		return nil, ErrNotFound
	}

	assertion, session, err := s.webauthn.BeginDiscoverableLogin()
	if err != nil {
		return nil, fmt.Errorf("auth: begin login: %w", err)
	}
	if err := s.store.SaveCeremony(ctx, session.Challenge, kindLogin, *session, ceremonyTTL); err != nil {
		return nil, err
	}

	return assertion, nil
}

// FinishLogin completes the login ceremony BeginLogin began, persisting the
// authenticator's bumped signature counter so a cloned authenticator is caught
// on a later login.
func (s *Service) FinishLogin(ctx context.Context, r *http.Request) (*User, error) {
	parsed, err := parseAssertion(r)
	if err != nil {
		return nil, err
	}
	key := parsed.Response.CollectedClientData.Challenge
	session, err := s.store.LoadCeremony(ctx, key, kindLogin)
	if err != nil {
		return nil, err
	}
	defer func() { _ = s.store.DeleteCeremony(ctx, key, kindLogin) }()

	u, err := s.store.Owner(ctx)
	if err != nil {
		return nil, err
	}

	// There is one account, so whoever the passkey names, the owner is the
	// answer. The library still checks the passkey's user handle against the
	// owner's ID and finds the credential among the owner's.
	owner := func(_, _ []byte) (webauthn.User, error) { return u, nil }
	cred, err := s.webauthn.ValidateDiscoverableLogin(owner, session, parsed)
	if err != nil {
		return nil, fmt.Errorf("auth: finish login: %w", err)
	}
	if err := s.store.UpdateCredential(ctx, *cred); err != nil {
		return nil, err
	}

	return u, nil
}

func parseCreation(r *http.Request) (*protocol.ParsedCredentialCreationData, error) {
	parsed, err := protocol.ParseCredentialCreationResponseBody(r.Body)
	if err != nil {
		return nil, fmt.Errorf("auth: parse registration response: %w", err)
	}

	return parsed, nil
}

func parseAssertion(r *http.Request) (*protocol.ParsedCredentialAssertionData, error) {
	parsed, err := protocol.ParseCredentialRequestResponseBody(r.Body)
	if err != nil {
		return nil, fmt.Errorf("auth: parse login response: %w", err)
	}

	return parsed, nil
}

// CreateSession issues a session token for the owner, ready to set as a cookie.
func (s *Service) CreateSession(ctx context.Context) (token string, err error) {
	return s.store.CreateSession(ctx, SessionTTL)
}

// HasAnyRegisteredUser reports whether any account has completed
// registration — an exported wrapper around the Store method of the same
// name, reachable from outside this package for the public
// registration-status endpoint.
func (s *Service) HasAnyRegisteredUser(ctx context.Context) (bool, error) {
	return s.store.HasAnyRegisteredUser(ctx)
}
