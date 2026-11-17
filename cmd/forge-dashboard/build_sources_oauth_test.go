package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

type pairStore struct{ token *oauth2.Token }

func (p *pairStore) SaveOAuthToken(_ context.Context, _ string, t *oauth2.Token) error {
	p.token = t

	return nil
}

func (p *pairStore) OAuthToken(context.Context, string) (*oauth2.Token, error) {
	if p.token == nil {
		return nil, settings.ErrNotFound
	}

	return p.token, nil
}

func (p *pairStore) DeleteOAuthToken(context.Context, string) error {
	p.token = nil

	return nil
}

func authHeaders(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()

	var (
		mu   sync.Mutex
		seen []string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		_, _ = w.Write([]byte(`[]`))
	}))
	t.Cleanup(srv.Close)

	return srv, func() []string {
		mu.Lock()
		defer mu.Unlock()

		return append([]string(nil), seen...)
	}
}

func TestBuildSources_ALinkedForgejoAccountSendsItsAccessTokenInPlaceOfAPastedOne(t *testing.T) {
	t.Parallel()

	srv, headers := authHeaders(t)
	store := &pairStore{token: &oauth2.Token{AccessToken: "linked", RefreshToken: "r", Expiry: time.Now().Add(time.Hour)}}
	conn := oauth.NewForgejo(t.Context(), "id", "secret", "https://dash.example.com/cb", store)

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, nil, conn)(settings.Credentials{ForgejoURL: srv.URL, ForgejoToken: "pasted"})
	require.Len(t, sources, 1)
	sources[0].Fetch(t.Context())

	require.NotEmpty(t, headers())
	for _, h := range headers() {
		assert.Equal(t, "Bearer linked", h)
	}
}

func TestBuildSources_ALinkedForgejoAccountNeedsNoPastedToken(t *testing.T) {
	t.Parallel()

	srv, headers := authHeaders(t)
	store := &pairStore{token: &oauth2.Token{AccessToken: "linked", RefreshToken: "r", Expiry: time.Now().Add(time.Hour)}}
	conn := oauth.NewForgejo(t.Context(), "id", "secret", "https://dash.example.com/cb", store)

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, nil, conn)(settings.Credentials{ForgejoURL: srv.URL, ForgejoUsername: "alice"})
	require.Len(t, sources, 1)
	sources[0].Fetch(t.Context())

	assert.Contains(t, headers(), "Bearer linked", "a linked account is an authenticated client, not the public-repos fallback")
}

func TestBuildSources_WithoutALinkedAccountThePastedTokenIsUsed(t *testing.T) {
	t.Parallel()

	srv, headers := authHeaders(t)
	conn := oauth.NewForgejo(t.Context(), "id", "secret", "https://dash.example.com/cb", &pairStore{})

	sources := buildSources(newTestAuthStore(t), nil, 0, nil, nil, conn)(settings.Credentials{ForgejoURL: srv.URL, ForgejoToken: "pasted"})
	require.Len(t, sources, 1)
	sources[0].Fetch(t.Context())

	require.NotEmpty(t, headers())
	for _, h := range headers() {
		assert.Equal(t, "token pasted", h)
	}
}
