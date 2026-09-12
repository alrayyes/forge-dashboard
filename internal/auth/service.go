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
	webauthn      *webauthn.WebAuthn
	store         *Store
	adminUsername string
}

// NewService returns a Service. adminUsername names the one account that
// becomes an admin on registration — established here, at startup, rather
// than by whoever happens to register first.
func NewService(wa *webauthn.WebAuthn, store *Store, adminUsername string) *Service {
	return &Service{webauthn: wa, store: store, adminUsername: adminUsername}
}

// BeginRegistration starts a registration ceremony for a brand-new
// username. Returns ErrAlreadyRegistered if that username already has an
// account.
func (s *Service) BeginRegistration(ctx context.Context, username, displayName string) (*protocol.CredentialCreation, error) {
	if _, err := s.store.GetUserByUsername(ctx, username); err == nil {
		return nil, ErrAlreadyRegistered
	} else if !errors.Is(err, ErrNotFound) {
		return nil, err
	}

	// A real user row from the first step, not a throwaway in-memory
	// stand-in — WebAuthnID has to be genuinely random and BeginRegistration
	// only reads from the User interface, so creating it now (rather than
	// after the ceremony finishes) means FinishRegistration has a real,
	// already-persisted ID to attach the credential to.
	isAdmin := s.adminUsername != "" && username == s.adminUsername
	u, err := s.store.CreateUser(ctx, username, displayName, isAdmin)
	if err != nil {
		return nil, err
	}

	creation, session, err := s.webauthn.BeginRegistration(u)
	if err != nil {
		return nil, err
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
	u.Credentials = append(u.Credentials, *cred)
	return u, nil
}

// BeginLogin starts a login ceremony for an existing username.
func (s *Service) BeginLogin(ctx context.Context, username string) (*protocol.CredentialAssertion, error) {
	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}

	assertion, session, err := s.webauthn.BeginLogin(u)
	if err != nil {
		return nil, err
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
