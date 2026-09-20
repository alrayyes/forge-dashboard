package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// ErrAlreadyRegistered is returned by BeginRegistration when the username
// is already taken.
var ErrAlreadyRegistered = errors.New("auth: username already registered")

// ErrInvalidInvite is returned by BeginRegistration when an invite is
// required (any account already exists) and the presented token is
// missing, unknown, expired, already consumed, or issued for a different
// username than the one being registered — deliberately one sentinel for
// every reason rather than one each, so a caller can't fingerprint which
// specific check failed.
var ErrInvalidInvite = errors.New("auth: invalid or expired invite")

// ErrNotAdmin is returned by an admin-only Service method when the
// requester isn't the designated admin.
var ErrNotAdmin = errors.New("auth: admin access required")

// inviteTTL is how long an admin-issued registration invite stays usable
// (design.md) — fixed, not admin-configurable: long enough to hand off a
// link and have the invitee act on it in one sitting, short enough that a
// stale, unconsumed invite isn't a standing credential.
const inviteTTL = time.Hour

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

// BeginRegistration starts a registration ceremony for a brand-new
// username. Returns ErrAlreadyRegistered if that username already has an
// account.
//
// The very first registration on a fresh instance bootstraps its admin
// and needs no invite — HasAnyRegisteredUser is false, so inviteToken is
// never even looked at. Every registration after that requires
// inviteToken to be a valid, unexpired, unconsumed invite issued for
// exactly username (ErrInvalidInvite otherwise), and the invite's own
// displayName wins over whatever the caller passed in — the admin who
// issued the invite chose it, not the anonymous request completing the
// ceremony.
func (s *Service) BeginRegistration(ctx context.Context, username, displayName, inviteToken string) (*protocol.CredentialCreation, error) {
	if existing, err := s.store.GetUserByUsername(ctx, username); err == nil {
		if len(existing.Credentials) > 0 {
			return nil, ErrAlreadyRegistered
		}
		// A registration was begun and never finished — a page reload
		// before the passkey prompt completed, say. Nothing was ever
		// actually attached to this username, so it's free to reclaim
		// rather than a permanent dead end nobody can log into either.
		if err := s.store.DeleteUnregisteredUser(ctx, username); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	// The first username to actually complete registration becomes admin
	// — checked before creating this row, so it reflects who's completed
	// so far, not who's merely begun (an abandoned attempt reclaimed by
	// DeleteUnregisteredUser above never counted as "the first user").
	hasAdmin, err := s.store.HasAnyRegisteredUser(ctx)
	if err != nil {
		return nil, err
	}

	if hasAdmin {
		invite, err := s.store.ConsumeInviteIfValid(ctx, inviteToken, username)
		if err != nil {
			return nil, ErrInvalidInvite
		}
		displayName = invite.DisplayName
	}

	// A real user row from the first step, not a throwaway in-memory
	// stand-in — WebAuthnID has to be genuinely random and BeginRegistration
	// only reads from the User interface, so creating it now (rather than
	// after the ceremony finishes) means FinishRegistration has a real,
	// already-persisted ID to attach the credential to.
	u, err := s.store.CreateUser(ctx, username, displayName, !hasAdmin)
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
	if err := s.store.AddCredential(ctx, u.ID, *cred); err != nil {
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

// CreateInvite generates a new single-use registration invite for
// username/displayName, issued by requester — ErrNotAdmin if requester
// isn't the designated admin, ErrAlreadyRegistered if username already has
// a completed registration (an abandoned, credential-less username is
// still fine to invite, same as it's still fine to self-reclaim via
// BeginRegistration).
func (s *Service) CreateInvite(ctx context.Context, requester *User, username, displayName string) (token string, invite *Invite, err error) {
	if requester == nil || !requester.IsAdmin {
		return "", nil, ErrNotAdmin
	}

	if existing, err := s.store.GetUserByUsername(ctx, username); err == nil {
		if len(existing.Credentials) > 0 {
			return "", nil, ErrAlreadyRegistered
		}
	} else if !errors.Is(err, ErrNotFound) {
		return "", nil, err
	}

	return s.store.CreateInvite(ctx, username, displayName, requester.ID, inviteTTL)
}

// HasAnyRegisteredUser reports whether any account has completed
// registration — an exported wrapper around the Store method of the same
// name, reachable from outside this package for the public
// registration-status endpoint (unauthenticated, so it has no *User of
// its own to check admin status against the way CreateInvite does).
func (s *Service) HasAnyRegisteredUser(ctx context.Context) (bool, error) {
	return s.store.HasAnyRegisteredUser(ctx)
}
