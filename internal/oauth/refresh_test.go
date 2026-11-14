package oauth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

// memorySaver is a fake token store.
type memorySaver struct {
	mu    sync.Mutex
	saved []*oauth2.Token
	err   error
}

func (m *memorySaver) Save(_ context.Context, tok *oauth2.Token) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.err != nil {
		return m.err
	}

	m.saved = append(m.saved, tok)

	return nil
}

func (m *memorySaver) all() []*oauth2.Token {
	m.mu.Lock()
	defer m.mu.Unlock()

	return append([]*oauth2.Token(nil), m.saved...)
}

// refreshForge answers refresh_token grants with a rotated pair.
func refreshForge(t *testing.T) (cfg oauth2.Config, forms func() []url.Values) {
	t.Helper()

	var (
		mu  sync.Mutex
		got []url.Values
	)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.NoError(t, r.ParseForm())
		mu.Lock()
		got = append(got, r.PostForm)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "access-2",
			"refresh_token": "refresh-2",
			"token_type":    "bearer",
			"expires_in":    3600,
		}))
	}))
	t.Cleanup(srv.Close)

	return oauth2.Config{
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		Endpoint:     oauth2.Endpoint{TokenURL: srv.URL + "/token"},
	}, func() []url.Values {
		mu.Lock()
		defer mu.Unlock()

		return append([]url.Values(nil), got...)
	}
}

func expiredToken() *oauth2.Token {
	return &oauth2.Token{
		AccessToken:  "access-1",
		RefreshToken: "refresh-1",
		Expiry:       time.Now().Add(-time.Minute),
	}
}

func TestSource_ExpiredToken_IsRefreshedAndTheRotatedPairSaved(t *testing.T) {
	t.Parallel()

	cfg, forms := refreshForge(t)
	saver := &memorySaver{}

	got, err := oauth.NewSource(t.Context(), cfg, expiredToken(), saver).Token()
	require.NoError(t, err)

	t.Run("returns the new access token", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "access-2", got.AccessToken)
	})

	t.Run("sends the stored refresh token", func(t *testing.T) {
		t.Parallel()
		require.Len(t, forms(), 1)
		assert.Equal(t, "refresh-1", forms()[0].Get("refresh_token"))
	})

	t.Run("saves the rotated refresh token", func(t *testing.T) {
		t.Parallel()
		require.Len(t, saver.all(), 1)
		assert.Equal(t, "refresh-2", saver.all()[0].RefreshToken)
	})
}

func TestSource_FreshToken_IsNeitherRefreshedNorSaved(t *testing.T) {
	t.Parallel()

	cfg, forms := refreshForge(t)
	saver := &memorySaver{}
	fresh := &oauth2.Token{AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(time.Hour)}

	_, err := oauth.NewSource(t.Context(), cfg, fresh, saver).Token()
	require.NoError(t, err)

	assert.Empty(t, forms())
	assert.Empty(t, saver.all())
}

func TestSource_RefreshesOnceForConcurrentCallers(t *testing.T) {
	t.Parallel()

	cfg, forms := refreshForge(t)
	source := oauth.NewSource(t.Context(), cfg, expiredToken(), &memorySaver{})

	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			_, err := source.Token()
			assert.NoError(t, err)
		})
	}

	wg.Wait()

	assert.Len(t, forms(), 1, "a second refresh would use an already-rotated token and fail")
}

func TestSource_SaveFails_TheErrorSurfacesInsteadOfLosingTheRotatedPair(t *testing.T) {
	t.Parallel()

	cfg, _ := refreshForge(t)
	saver := &memorySaver{err: assert.AnError}

	_, err := oauth.NewSource(t.Context(), cfg, expiredToken(), saver).Token()

	require.ErrorIs(t, err, assert.AnError)
}
