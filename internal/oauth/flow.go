package oauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// ErrInvalidState is what Complete answers for a callback whose state we never
// issued, already used, or let expire. The handler turns it into a 400 and
// stores nothing.
var ErrInvalidState = errors.New("oauth: unknown, used or expired state")

// ErrExchange is what Complete answers when the forge refused the code, or the
// verifier didn't match the challenge, or the token endpoint couldn't be
// reached. Nothing was stored.
var ErrExchange = errors.New("oauth: code exchange failed")

type attempt struct {
	cfg      oauth2.Config
	instance string
	verifier string
	expires  time.Time
}

// Flow runs the authorization code grant with PKCE (S256) against one forge.
// Each Begin issues a fresh state and code verifier, held in memory until the
// callback uses them once or the ttl runs out. A restart drops pending
// attempts, which only costs the user a second click.
type Flow struct {
	cfg oauth2.Config
	ttl time.Duration
	now func() time.Time

	mu      sync.Mutex
	pending map[string]attempt
}

// NewFlow builds a Flow for cfg. now is injected so expiry is testable.
func NewFlow(cfg oauth2.Config, ttl time.Duration, now func() time.Time) *Flow {
	return &Flow{cfg: cfg, ttl: ttl, now: now, pending: map[string]attempt{}}
}

// Begin starts an attempt and returns the forge URL to send the browser to.
func (f *Flow) Begin() string {
	return f.BeginWith(f.cfg.Endpoint, "")
}

// BeginWith is Begin against a forge whose endpoints are known only now, such
// as a self-hosted instance the owner names. instance rides along with the
// attempt and comes back from CompleteWith, so the callback knows which
// instance the state was issued for without trusting anything in the request.
func (f *Flow) BeginWith(endpoint oauth2.Endpoint, instance string) string {
	state := rand.Text()
	verifier := oauth2.GenerateVerifier()

	cfg := f.cfg
	cfg.Endpoint = endpoint

	f.mu.Lock()
	defer f.mu.Unlock()

	f.dropExpired()
	f.pending[state] = attempt{cfg: cfg, instance: instance, verifier: verifier, expires: f.now().Add(f.ttl)}

	return cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

// Complete checks state, then exchanges code for a token using the verifier
// that went with that state. The state is consumed either way, so a replayed
// callback fails. An unknown or expired state never reaches the token endpoint.
func (f *Flow) Complete(ctx context.Context, state, code string) (*oauth2.Token, error) {
	token, _, err := f.CompleteWith(ctx, state, code)

	return token, err
}

// CompleteWith is Complete for an attempt started with BeginWith. It also
// returns the instance that attempt named.
func (f *Flow) CompleteWith(ctx context.Context, state, code string) (*oauth2.Token, string, error) {
	token, instance, _, err := f.complete(ctx, state, code)

	return token, instance, err
}

// complete is CompleteWith that also returns the client id the attempt used
// when it was a public one (no secret), and "" otherwise.
func (f *Flow) complete(ctx context.Context, state, code string) (*oauth2.Token, string, string, error) {
	a, ok := f.take(state)
	if !ok {
		return nil, "", "", ErrInvalidState
	}

	token, err := a.cfg.Exchange(withClient(ctx), code, oauth2.VerifierOption(a.verifier))
	if err != nil {
		return nil, "", "", fmt.Errorf("%w: %s", ErrExchange, redact(err))
	}

	publicID := ""
	if a.cfg.ClientSecret == "" {
		publicID = a.cfg.ClientID
	}

	return token, a.instance, publicID, nil
}

// BeginAs is BeginWith for a client the owner named for this attempt only. It
// has no secret and asks for scopes; the attempt remembers the client id.
func (f *Flow) BeginAs(endpoint oauth2.Endpoint, instance, clientID string, scopes []string) string {
	state := rand.Text()
	verifier := oauth2.GenerateVerifier()

	cfg := f.cfg
	cfg.Endpoint, cfg.ClientID, cfg.ClientSecret, cfg.Scopes = endpoint, clientID, "", scopes

	f.mu.Lock()
	defer f.mu.Unlock()

	f.dropExpired()
	f.pending[state] = attempt{cfg: cfg, instance: instance, verifier: verifier, expires: f.now().Add(f.ttl)}

	return cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

// take removes and returns the attempt issued for state. The comparison runs
// against every pending state in constant time, so the time it takes says
// nothing about how much of a guess matched.
func (f *Flow) take(state string) (attempt, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()

	var (
		found attempt
		key   string
		ok    bool
	)

	for candidate, a := range f.pending {
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(state)) == 1 {
			found, key, ok = a, candidate, true
		}
	}

	if ok {
		delete(f.pending, key)
	}

	if !ok || !f.now().Before(found.expires) {
		return attempt{}, false
	}

	return found, true
}

// dropExpired keeps abandoned attempts from piling up. Callers hold f.mu.
func (f *Flow) dropExpired() {
	now := f.now()
	for state, a := range f.pending {
		if !now.Before(a.expires) {
			delete(f.pending, state)
		}
	}
}
