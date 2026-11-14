package oauth

import (
	"context"
	"crypto/rand"
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

type attempt struct {
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
	state := rand.Text()
	verifier := oauth2.GenerateVerifier()

	f.mu.Lock()
	defer f.mu.Unlock()

	f.dropExpired()
	f.pending[state] = attempt{verifier: verifier, expires: f.now().Add(f.ttl)}

	return f.cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

// Complete checks state, then exchanges code for a token using the verifier
// that went with that state. The state is consumed either way, so a replayed
// callback fails. An unknown or expired state never reaches the token endpoint.
func (f *Flow) Complete(ctx context.Context, state, code string) (*oauth2.Token, error) {
	a, ok := f.take(state)
	if !ok {
		return nil, ErrInvalidState
	}

	token, err := f.cfg.Exchange(ctx, code, oauth2.VerifierOption(a.verifier))
	if err != nil {
		return nil, fmt.Errorf("oauth: exchange code: %w", err)
	}

	return token, nil
}

func (f *Flow) take(state string) (attempt, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()

	a, ok := f.pending[state]
	delete(f.pending, state)

	if !ok || !f.now().Before(a.expires) {
		return attempt{}, false
	}

	return a, true
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
