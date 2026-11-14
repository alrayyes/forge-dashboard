package oauth

import (
	"context"
	"fmt"
	"sync"

	"golang.org/x/oauth2"
)

// Saver persists a token pair. The settings store implements it per forge.
type Saver interface {
	Save(ctx context.Context, token *oauth2.Token) error
}

// Source hands out a valid access token, refreshing it when it expires and
// saving the new pair before anyone uses it. Refresh tokens rotate (GitHub
// invalidates the old pair on every refresh), so the pair that isn't saved is
// the pair that locks the owner out. One lock serialises refreshes, so two
// callers never spend the same refresh token.
type Source struct {
	ctx   context.Context //nolint:containedctx // oauth2 takes the context at construction for its refresh calls.
	cfg   oauth2.Config
	saver Saver

	mu      sync.Mutex
	current *oauth2.Token
	unsaved bool
}

// NewSource starts from the stored token. ctx carries the HTTP client used to
// reach the forge's token endpoint.
func NewSource(ctx context.Context, cfg oauth2.Config, stored *oauth2.Token, saver Saver) *Source {
	return &Source{ctx: ctx, cfg: cfg, current: stored, saver: saver}
}

// Token returns a valid access token. If a refresh succeeded but saving the
// pair failed, the new pair stays in memory and the save is retried on the
// next call, and the error is returned until it lands.
func (s *Source) Token() (*oauth2.Token, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.current.Valid() {
		fresh, err := s.cfg.TokenSource(s.ctx, s.current).Token()
		if err != nil {
			return nil, fmt.Errorf("oauth: refresh token: %w", err)
		}

		s.current, s.unsaved = fresh, true
	}

	if s.unsaved {
		if err := s.saver.Save(s.ctx, s.current); err != nil {
			return nil, fmt.Errorf("oauth: save refreshed token: %w", err)
		}

		s.unsaved = false
	}

	return s.current, nil
}
