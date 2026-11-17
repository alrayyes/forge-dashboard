package oauth_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/oauth"
	"github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/oauth2"
)

const (
	testRedirect = "https://dash.example.com/api/v1/connections/forgejo/callback"
	goodCode     = "good-code"
)

// memoryTokens is a fake token store, one pair.
type memoryTokens struct {
	mu       sync.Mutex
	instance string
	token    *oauth2.Token
	saves    int
}

func (m *memoryTokens) SaveOAuthToken(_ context.Context, forge, instance string, t *oauth2.Token) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if forge != "forgejo" {
		panic("wrong forge " + forge)
	}
	m.instance, m.token, m.saves = instance, t, m.saves+1

	return nil
}

func (m *memoryTokens) OAuthToken(_ context.Context, _ string) (string, *oauth2.Token, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.token == nil {
		return "", nil, settings.ErrNotFound
	}

	return m.instance, m.token, nil
}

func (m *memoryTokens) DeleteOAuthToken(_ context.Context, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = nil

	return nil
}

func (m *memoryTokens) current() *oauth2.Token {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.token
}

// fakeForgejo is an instance with the OAuth endpoints and GET /api/v1/user. It
// enforces what a real one does: the redirect URI matches the one registered,
// the PKCE verifier hashes to the challenge, a refresh token works once.
type fakeForgejo struct {
	server *httptest.Server

	mu        sync.Mutex
	challenge string
	refreshes int
	valid     string // refresh token that still works
	access    string // newest access token
	userCalls int
	userFails bool
	hits      int
}

func newFakeForgejo(t *testing.T) *fakeForgejo {
	t.Helper()

	f := &fakeForgejo{valid: "refresh-1", access: "access-1"}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", f.token)
	mux.HandleFunc("/api/v1/user", f.user)
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.hits++
		f.mu.Unlock()
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(f.server.Close)

	return f
}

func (f *fakeForgejo) token(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	_ = r.ParseForm()
	form := r.PostForm
	deny := func() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		// A proxy or a hostile instance can put anything in the body, including
		// what it was sent. Echo it so a test can tell if it ever leaks on.
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "invalid_grant",
			"error_description": "denied: " + form.Get("code") + " " + form.Get("client_secret") + " " + form.Get("refresh_token") + " " + form.Get("code_verifier"),
		})
	}

	switch form.Get("grant_type") {
	case "authorization_code":
		sum := sha256.Sum256([]byte(form.Get("code_verifier")))
		if form.Get("code") != goodCode ||
			form.Get("redirect_uri") != testRedirect ||
			form.Get("client_id") != "client-id" || form.Get("client_secret") != "client-secret" ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge {
			deny()

			return
		}
	case "refresh_token":
		if form.Get("refresh_token") != f.valid {
			deny()

			return
		}
		f.refreshes++
		f.valid = "refresh-" + strconv.Itoa(f.refreshes+1)
		f.access = "access-" + strconv.Itoa(f.refreshes+1)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": f.access, "refresh_token": f.valid, "token_type": "bearer", "expires_in": 3600,
	})
}

func (f *fakeForgejo) user(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.userCalls++
	if f.userFails || r.Header.Get("Authorization") != "Bearer "+f.access {
		http.Error(w, "no", http.StatusUnauthorized)

		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
}

func (f *fakeForgejo) setChallenge(c string) {
	f.mu.Lock()
	f.challenge = c
	f.mu.Unlock()
}

func (f *fakeForgejo) refreshCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.refreshes
}

func newForgejoConn(t *testing.T, store *memoryTokens) *oauth.Forgejo {
	t.Helper()

	return oauth.NewForgejo(t.Context(), "client-id", "client-secret", testRedirect, store)
}

// begun starts a flow against forge and returns the query the browser would carry.
func begun(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo, instance string) url.Values {
	t.Helper()

	u, err := url.Parse(conn.Begin(instance))
	require.NoError(t, err)
	forge.setChallenge(u.Query().Get("code_challenge"))

	return u.Query()
}

func TestForgejo_Begin_SendsTheBrowserToTheInstanceWithTheExactRedirectURI(t *testing.T) {
	t.Parallel()

	conn := newForgejoConn(t, &memoryTokens{})
	u, err := url.Parse(conn.Begin("https://git.example.com/"))
	require.NoError(t, err)

	assert.Equal(t, "git.example.com", u.Host)
	assert.Equal(t, "/login/oauth/authorize", u.Path)
	assert.Equal(t, testRedirect, u.Query().Get("redirect_uri"))
	assert.Equal(t, "S256", u.Query().Get("code_challenge_method"))
	assert.Equal(t, "client-id", u.Query().Get("client_id"))
	assert.NotContains(t, u.String(), "client-secret")
}

func TestForgejo_Finish_StoresTheEncryptedPairsSourceAndNamesTheAccount(t *testing.T) {
	t.Parallel()

	forge, store := newFakeForgejo(t), &memoryTokens{}
	conn := newForgejoConn(t, store)
	q := begun(t, conn, forge, forge.server.URL)

	instance, account, err := conn.Finish(t.Context(), q.Get("state"), goodCode)

	require.NoError(t, err)
	assert.Equal(t, forge.server.URL, instance)
	assert.Equal(t, "alice", account)
	require.NotNil(t, store.current())
	assert.Equal(t, "access-1", store.current().AccessToken)
	assert.Equal(t, "refresh-1", store.current().RefreshToken)
}

func TestForgejo_Finish_StoresNothingWhenTheCallbackCannotBeTrusted(t *testing.T) {
	t.Parallel()

	for name, run := range map[string]func(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo, state string) error{
		"a state we never issued": func(t *testing.T, conn *oauth.Forgejo, _ *fakeForgejo, _ string) error {
			t.Helper()
			_, _, err := conn.Finish(t.Context(), "forged-state", goodCode)

			return wrapFinish(err)
		},
		"an empty state": func(t *testing.T, conn *oauth.Forgejo, _ *fakeForgejo, _ string) error {
			t.Helper()
			_, _, err := conn.Finish(t.Context(), "", goodCode)

			return wrapFinish(err)
		},
		"a verifier that does not match the challenge": func(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo, state string) error {
			t.Helper()
			forge.setChallenge("a-different-challenge")
			_, _, err := conn.Finish(t.Context(), state, goodCode)

			return wrapFinish(err)
		},
		"a code the instance refuses": func(t *testing.T, conn *oauth.Forgejo, _ *fakeForgejo, state string) error {
			t.Helper()
			_, _, err := conn.Finish(t.Context(), state, "stolen-code")

			return wrapFinish(err)
		},
		"an account that cannot be read": func(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo, state string) error {
			t.Helper()
			forge.mu.Lock()
			forge.userFails = true
			forge.mu.Unlock()
			_, _, err := conn.Finish(t.Context(), state, goodCode)

			return wrapFinish(err)
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			forge, store := newFakeForgejo(t), &memoryTokens{}
			conn := newForgejoConn(t, store)
			q := begun(t, conn, forge, forge.server.URL)

			require.Error(t, run(t, conn, forge, q.Get("state")))
			assert.Nil(t, store.current(), "nothing may be stored")
		})
	}
}

func TestForgejo_Finish_AStateWorksOnce(t *testing.T) {
	t.Parallel()

	forge, store := newFakeForgejo(t), &memoryTokens{}
	conn := newForgejoConn(t, store)
	state := begun(t, conn, forge, forge.server.URL).Get("state")

	_, _, err := conn.Finish(t.Context(), state, goodCode)
	require.NoError(t, err)
	require.NoError(t, store.DeleteOAuthToken(t.Context(), "forgejo"))

	_, _, err = conn.Finish(t.Context(), state, goodCode)
	require.ErrorIs(t, err, oauth.ErrInvalidState)
	assert.Nil(t, store.current())
}

func TestForgejo_Finish_NamesWhyTheAccountReadFailed(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	forge.userFails = true
	conn := newForgejoConn(t, &memoryTokens{})
	q := begun(t, conn, forge, forge.server.URL)

	_, _, err := conn.Finish(t.Context(), q.Get("state"), goodCode)

	require.ErrorIs(t, err, oauth.ErrAccount)
}

func connected(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo) {
	t.Helper()

	q := begun(t, conn, forge, forge.server.URL)
	_, _, err := conn.Finish(t.Context(), q.Get("state"), goodCode)
	require.NoError(t, err)
}

func TestForgejo_Bearer_HandsOutTheStoredAccessToken(t *testing.T) {
	t.Parallel()

	forge, store := newFakeForgejo(t), &memoryTokens{}
	conn := newForgejoConn(t, store)
	connected(t, conn, forge)

	bearer, ok := conn.Bearer(t.Context(), forge.server.URL)

	require.True(t, ok)
	tok, err := bearer()
	require.NoError(t, err)
	assert.Equal(t, "access-1", tok)
}

func TestForgejo_Bearer_NotConnectedIsNotOK(t *testing.T) {
	t.Parallel()

	conn := newForgejoConn(t, &memoryTokens{})
	_, ok := conn.Bearer(t.Context(), "https://git.example.com")

	assert.False(t, ok)
}

func TestForgejo_Bearer_AnExpiredTokenRefreshesOnceAndTheRotatedPairIsSaved(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
		AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newForgejoConn(t, store)
	bearer, ok := conn.Bearer(t.Context(), forge.server.URL)
	require.True(t, ok)

	var wg sync.WaitGroup
	got := make([]string, 8)
	for i := range got {
		wg.Go(func() {
			tok, err := bearer()
			assert.NoError(t, err)
			got[i] = tok
		})
	}
	wg.Wait()

	assert.Equal(t, 1, forge.refreshCount(), "one refresh however many callers raced")
	assert.Equal(t, "refresh-2", store.current().RefreshToken, "the rotated refresh token is the one on file")
	for _, tok := range got {
		assert.Equal(t, "access-2", tok)
	}
}

func TestForgejo_Bearer_ASurvivingSourceIsSharedSoOneRefreshTokenIsNeverSpentTwice(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
		AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newForgejoConn(t, store)

	first, _ := conn.Bearer(t.Context(), forge.server.URL)
	_, err := first()
	require.NoError(t, err)
	// A settings save rebuilds the sources and asks again.
	second, ok := conn.Bearer(t.Context(), forge.server.URL)
	require.True(t, ok)
	_, err = second()
	require.NoError(t, err)

	assert.Equal(t, 1, forge.refreshCount())
}

func TestForgejo_Disconnect_DeletesTheTokensAndASlowRefreshCannotPutThemBack(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
		AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newForgejoConn(t, store)
	bearer, ok := conn.Bearer(t.Context(), forge.server.URL)
	require.True(t, ok)

	require.NoError(t, conn.Disconnect(t.Context()))
	_, err := bearer() // a request that was already in flight

	require.Error(t, err)
	assert.Nil(t, store.current(), "the refresh must not resurrect the deleted pair")
	_, ok = conn.Bearer(t.Context(), forge.server.URL)
	assert.False(t, ok)
}

func TestForgejo_Connected_IsFalseWithoutAClient(t *testing.T) {
	t.Parallel()

	var conn *oauth.Forgejo

	assert.False(t, conn.Configured())
	assert.False(t, oauth.NewForgejo(t.Context(), "", "", testRedirect, &memoryTokens{}).Configured())
}

func wrapFinish(err error) error {
	if err != nil {
		return fmt.Errorf("finish: %w", err)
	}

	return nil
}

func finishedAgainst(t *testing.T, forge *fakeForgejo, store *memoryTokens) *oauth.Forgejo {
	t.Helper()

	conn := newForgejoConn(t, store)
	state := beginAgainst(t, conn, forge)
	_, _, err := conn.Finish(t.Context(), state, goodCode)
	require.NoError(t, err)

	return conn
}

// The stored pair belongs to the host that granted it. Asked about another
// address, Bearer says "not linked" and sends nothing to it, not even a refresh
// with the client secret.
func TestForgejo_Bearer_ARefusesAnInstanceThatDidNotGrantTheToken(t *testing.T) {
	t.Parallel()

	granted, other := newFakeForgejo(t), newFakeForgejo(t)
	store := &memoryTokens{}
	conn := finishedAgainst(t, granted, store)
	store.token.Expiry = time.Now().Add(-time.Minute) // a refresh would be needed

	bearer, ok := conn.Bearer(t.Context(), other.server.URL)

	assert.False(t, ok)
	assert.Nil(t, bearer)
	assert.Zero(t, other.refreshCount())
	assert.Zero(t, other.requests(), "nothing at all reaches the other host")
	_, ok = conn.Bearer(t.Context(), granted.server.URL)
	assert.True(t, ok, "the granting host is still served")
}

func TestForgejo_Bearer_TheInstanceIsStoredWithThePair(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	store := &memoryTokens{}
	finishedAgainst(t, forge, store)

	assert.Equal(t, forge.server.URL, store.instance)
}

func TestForgejo_Bearer_ARefreshedPairIsSavedWithItsInstance(t *testing.T) {
	t.Parallel()

	forge := newFakeForgejo(t)
	store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
		AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newForgejoConn(t, store)
	bearer, ok := conn.Bearer(t.Context(), forge.server.URL)
	require.True(t, ok)
	_, err := bearer()
	require.NoError(t, err)

	assert.Equal(t, forge.server.URL, store.instance)
}

// Go re-sends a 307 or 308 POST body to the target. The token request's body
// holds the client secret, the code and the verifier.
func TestForgejo_TokenRequests_NeverFollowARedirect(t *testing.T) {
	t.Parallel()

	var (
		mu   sync.Mutex
		seen []string
	)
	target := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		mu.Lock()
		seen = append(seen, r.PostForm.Encode())
		mu.Unlock()
	}))
	t.Cleanup(target.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)

	t.Run("requests", func(t *testing.T) {
		t.Run("the code exchange", func(t *testing.T) {
			conn := newForgejoConn(t, &memoryTokens{})
			consent, err := url.Parse(conn.Begin(redirector.URL))
			require.NoError(t, err)
			_, _, err = conn.Finish(t.Context(), consent.Query().Get("state"), goodCode)

			require.ErrorIs(t, err, oauth.ErrExchange)
		})

		t.Run("a refresh", func(t *testing.T) {
			store := &memoryTokens{instance: redirector.URL, token: &oauth2.Token{
				AccessToken: "a", RefreshToken: "r", Expiry: time.Now().Add(-time.Minute),
			}}
			bearer, ok := newForgejoConn(t, store).Bearer(t.Context(), redirector.URL)
			require.True(t, ok)
			_, err := bearer()

			require.Error(t, err)
		})
	})

	mu.Lock()
	defer mu.Unlock()
	assert.Empty(t, seen, "the redirect target received a request: %v", seen)
}

// An instance, or a proxy in front of it, can put what it was sent into its
// error answer. None of it may reach an error the caller logs or shows.
func TestForgejo_ErrorsFromTheTokenEndpoint_CarryNoSecret(t *testing.T) {
	t.Parallel()

	secrets := []string{"client-secret", "stolen-code", "refresh-1", "refresh-secret-xyz"}

	t.Run("the code exchange", func(t *testing.T) {
		t.Parallel()

		forge := newFakeForgejo(t)
		conn := newForgejoConn(t, &memoryTokens{})
		state := beginAgainst(t, conn, forge)
		_, _, err := conn.Finish(t.Context(), state, "stolen-code")

		require.ErrorIs(t, err, oauth.ErrExchange)
		for _, secret := range secrets {
			assert.NotContains(t, err.Error(), secret)
		}
		assert.Contains(t, err.Error(), "invalid_grant", "the standard error code is kept")
	})

	t.Run("a refresh", func(t *testing.T) {
		t.Parallel()

		forge := newFakeForgejo(t)
		store := &memoryTokens{instance: forge.server.URL, token: &oauth2.Token{
			AccessToken: "a", RefreshToken: "refresh-secret-xyz", Expiry: time.Now().Add(-time.Minute),
		}}
		bearer, ok := newForgejoConn(t, store).Bearer(t.Context(), forge.server.URL)
		require.True(t, ok)
		_, err := bearer()

		require.Error(t, err)
		for _, secret := range secrets {
			assert.NotContains(t, err.Error(), secret)
		}
	})
}

func (f *fakeForgejo) requests() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.hits
}

func beginAgainst(t *testing.T, conn *oauth.Forgejo, forge *fakeForgejo) string {
	t.Helper()

	return begun(t, conn, forge, forge.server.URL).Get("state")
}
