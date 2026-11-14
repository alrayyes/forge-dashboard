package oauth_test

import (
	"crypto/sha256"
	"encoding/base64"
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

// fakeForge is a token endpoint that records every exchange it receives.
type fakeForge struct {
	server *httptest.Server

	mu    sync.Mutex
	forms []url.Values
}

func newFakeForge(t *testing.T) *fakeForge {
	t.Helper()

	f := &fakeForge{}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.NoError(t, r.ParseForm())
		f.mu.Lock()
		f.forms = append(f.forms, r.PostForm)
		f.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "access-1",
			"refresh_token": "refresh-1",
			"token_type":    "bearer",
			"expires_in":    3600,
		}))
	}))
	t.Cleanup(f.server.Close)

	return f
}

func (f *fakeForge) exchanges() []url.Values {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]url.Values(nil), f.forms...)
}

func newFlow(t *testing.T, f *fakeForge, now func() time.Time) *oauth.Flow {
	t.Helper()

	return oauth.NewFlow(oauth2.Config{
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "https://dash.example.com/api/v1/connections/github/callback",
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://forge.example.com/login/oauth/authorize",
			TokenURL: f.server.URL + "/login/oauth/access_token",
		},
	}, 10*time.Minute, now)
}

func begin(t *testing.T, flow *oauth.Flow) url.Values {
	t.Helper()

	u, err := url.Parse(flow.Begin())
	require.NoError(t, err)

	return u.Query()
}

func TestFlow_Begin_AsksForACodeWithPKCEAndState(t *testing.T) {
	t.Parallel()

	q := begin(t, newFlow(t, newFakeForge(t), time.Now))

	for name, want := range map[string]string{
		"response_type":         "code",
		"client_id":             "client-id",
		"redirect_uri":          "https://dash.example.com/api/v1/connections/github/callback",
		"code_challenge_method": "S256", // plain PKCE is deprecated (RFC 9700)
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.Equal(t, want, q.Get(name))
		})
	}

	for _, name := range []string{"code_challenge", "state"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			assert.NotEmpty(t, q.Get(name))
		})
	}
}

func TestFlow_Begin_GivesEveryAttemptItsOwnStateAndChallenge(t *testing.T) {
	t.Parallel()

	flow := newFlow(t, newFakeForge(t), time.Now)
	first, second := begin(t, flow), begin(t, flow)

	assert.NotEqual(t, first.Get("state"), second.Get("state"))
	assert.NotEqual(t, first.Get("code_challenge"), second.Get("code_challenge"))
}

func TestFlow_Complete_ExchangesTheCodeWithTheVerifierBehindTheChallenge(t *testing.T) {
	t.Parallel()

	forge := newFakeForge(t)
	flow := newFlow(t, forge, time.Now)
	q := begin(t, flow)

	token, err := flow.Complete(t.Context(), q.Get("state"), "the-code")
	require.NoError(t, err)

	exchanges := forge.exchanges()
	require.Len(t, exchanges, 1)

	t.Run("returns the access token", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "access-1", token.AccessToken)
	})

	t.Run("returns the refresh token", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "refresh-1", token.RefreshToken)
	})

	t.Run("takes the expiry from expires_in", func(t *testing.T) {
		t.Parallel()
		assert.True(t, token.Expiry.After(time.Now()))
	})

	t.Run("sends the code it was given", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "the-code", exchanges[0].Get("code"))
	})

	t.Run("sends a verifier that hashes to the challenge the forge was shown", func(t *testing.T) {
		t.Parallel()
		sum := sha256.Sum256([]byte(exchanges[0].Get("code_verifier")))
		assert.Equal(t, q.Get("code_challenge"), base64.RawURLEncoding.EncodeToString(sum[:]))
	})
}

func TestFlow_Complete_UnknownState_IsRejectedBeforeTheForgeIsCalled(t *testing.T) {
	t.Parallel()

	forge := newFakeForge(t)
	flow := newFlow(t, forge, time.Now)
	begin(t, flow)

	_, err := flow.Complete(t.Context(), "not-a-state-we-issued", "the-code")

	require.ErrorIs(t, err, oauth.ErrInvalidState)
	assert.Empty(t, forge.exchanges(), "a callback we never started must not reach the token endpoint")
}

func TestFlow_Complete_StateIsSingleUse(t *testing.T) {
	t.Parallel()

	flow := newFlow(t, newFakeForge(t), time.Now)
	state := begin(t, flow).Get("state")

	_, err := flow.Complete(t.Context(), state, "the-code")
	require.NoError(t, err)

	_, err = flow.Complete(t.Context(), state, "the-code")
	require.ErrorIs(t, err, oauth.ErrInvalidState, "a replayed callback must fail")
}

func TestFlow_Complete_ExpiredState_IsRejected(t *testing.T) {
	t.Parallel()

	forge := newFakeForge(t)
	clock := time.Date(2026, 11, 14, 12, 0, 0, 0, time.UTC)
	flow := newFlow(t, forge, func() time.Time { return clock })
	state := begin(t, flow).Get("state")

	clock = clock.Add(11 * time.Minute)
	_, err := flow.Complete(t.Context(), state, "the-code")

	require.ErrorIs(t, err, oauth.ErrInvalidState)
	assert.Empty(t, forge.exchanges())
}
