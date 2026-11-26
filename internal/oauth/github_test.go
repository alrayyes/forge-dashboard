package oauth_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
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

const ghRedirect = "https://dash.example.com/api/v1/connections/github/callback"

// ghTokens is a fake token store for the "github" row.
type ghTokens struct {
	mu       sync.Mutex
	instance string
	token    *oauth2.Token
}

func (m *ghTokens) SaveOAuthToken(_ context.Context, forge, instance string, t *oauth2.Token) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if forge != "github" {
		panic("wrong forge " + forge)
	}
	m.instance, m.token = instance, t

	return nil
}

func (m *ghTokens) OAuthToken(_ context.Context, _ string) (string, *oauth2.Token, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.token == nil {
		return "", nil, settings.ErrNotFound
	}

	return m.instance, m.token, nil
}

func (m *ghTokens) DeleteOAuthToken(_ context.Context, _ string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = nil

	return nil
}

func (m *ghTokens) current() *oauth2.Token {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.token
}

// fakeGitHub serves the token endpoint and GET /user the way GitHub does for a
// GitHub App: the PKCE verifier must hash to the challenge, an expiring token
// comes with a refresh token that works once, and a refusal is a 200 with an
// error body for the authorization code grant.
type fakeGitHub struct {
	server *httptest.Server

	mu        sync.Mutex
	challenge string
	refreshes int
	valid     string
	access    string
	userFails bool

	// grants records each DELETE /applications/{id}/grant: who asked, with
	// what body, and whether the dashboard still held the pair at that moment.
	grants      []grantCall
	grantStatus int
	holds       func() bool
}

type grantCall struct {
	path, user, secret, token string
	stillStored               bool
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()

	f := &fakeGitHub{valid: "ghr-1", access: "ghu-1"}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", f.token)
	mux.HandleFunc("/user", f.user)
	mux.HandleFunc("/applications/", f.grant)
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)

	return f
}

func (f *fakeGitHub) grant(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	user, secret, _ := r.BasicAuth()
	var body struct {
		AccessToken string `json:"access_token"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	call := grantCall{path: r.Method + " " + r.URL.Path, user: user, secret: secret, token: body.AccessToken}
	if f.holds != nil {
		call.stillStored = f.holds()
	}
	f.grants = append(f.grants, call)

	status := f.grantStatus
	if status == 0 {
		status = http.StatusNoContent
	}
	w.WriteHeader(status)
}

func (f *fakeGitHub) grantCalls() []grantCall {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]grantCall(nil), f.grants...)
}

func (f *fakeGitHub) urls() oauth.GitHubURLs {
	return oauth.GitHubURLs{Web: f.server.URL, API: f.server.URL}
}

func (f *fakeGitHub) token(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	_ = r.ParseForm()
	form := r.PostForm
	deny := func() {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":             "bad_verification_code",
			"error_description": "denied: " + form.Get("code") + " " + form.Get("client_secret") + " " + form.Get("refresh_token"),
		})
	}

	switch form.Get("grant_type") {
	case "authorization_code":
		sum := sha256.Sum256([]byte(form.Get("code_verifier")))
		if form.Get("code") != "good-code" || form.Get("redirect_uri") != ghRedirect ||
			form.Get("client_id") != "gh-id" || form.Get("client_secret") != "gh-secret" ||
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
		f.valid = "ghr-" + strconv.Itoa(f.refreshes+1)
		f.access = "ghu-" + strconv.Itoa(f.refreshes+1)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"access_token": f.access, "refresh_token": f.valid, "token_type": "bearer",
		"expires_in": 28800, "refresh_token_expires_in": 15811200,
	})
}

func (f *fakeGitHub) user(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.userFails || r.Header.Get("Authorization") != "Bearer "+f.access {
		http.Error(w, "no", http.StatusUnauthorized)

		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"login": "octocat"})
}

func (f *fakeGitHub) setChallenge(c string) {
	f.mu.Lock()
	f.challenge = c
	f.mu.Unlock()
}

func (f *fakeGitHub) refreshCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.refreshes
}

func newGitHubConn(t *testing.T, gh *fakeGitHub, store *ghTokens) *oauth.GitHub {
	t.Helper()

	return oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghRedirect, store, gh.urls())
}

func ghBegin(t *testing.T, conn *oauth.GitHub, gh *fakeGitHub) url.Values {
	t.Helper()

	u, err := url.Parse(conn.Begin())
	require.NoError(t, err)
	gh.setChallenge(u.Query().Get("code_challenge"))

	return u.Query()
}

func TestGitHub_Begin_SendsTheBrowserToGitHubWithPKCEStateAndTheExactRedirect(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn := newGitHubConn(t, gh, &ghTokens{})
	u, err := url.Parse(conn.Begin())
	require.NoError(t, err)

	assert.Equal(t, gh.server.URL+"/login/oauth/authorize", u.Scheme+"://"+u.Host+u.Path)
	q := u.Query()
	assert.Equal(t, "gh-id", q.Get("client_id"))
	assert.Equal(t, ghRedirect, q.Get("redirect_uri"))
	assert.Equal(t, "S256", q.Get("code_challenge_method"))
	assert.NotEmpty(t, q.Get("code_challenge"))
	assert.NotEmpty(t, q.Get("state"))
	assert.Empty(t, q.Get("scope"), "a GitHub App's user token takes its limits from the App, not a scope")
	assert.NotContains(t, u.String(), "gh-secret")
}

func TestGitHub_Finish_StoresThePairSealedToGitHubAndNamesTheAccount(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	store := &ghTokens{}
	conn := newGitHubConn(t, gh, store)
	q := ghBegin(t, conn, gh)

	login, err := conn.Finish(t.Context(), q.Get("state"), "good-code")

	require.NoError(t, err)
	assert.Equal(t, "octocat", login)
	assert.Equal(t, "ghu-1", store.current().AccessToken)
	assert.Equal(t, "ghr-1", store.current().RefreshToken)
	assert.Equal(t, gh.server.URL, store.instance)
	assert.False(t, store.current().Expiry.IsZero(), "GitHub's user tokens expire")
}

func TestGitHub_Finish_StoresNothingWhenTheCallbackCannotBeTrusted(t *testing.T) {
	t.Parallel()

	tests := map[string]func(state string) (string, string){
		"an unknown state": func(string) (string, string) { return "forged", "good-code" },
		"a refused code":   func(state string) (string, string) { return state, "wrong-code" },
	}
	for name, args := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			gh := newFakeGitHub(t)
			store := &ghTokens{}
			conn := newGitHubConn(t, gh, store)
			state, code := args(ghBegin(t, conn, gh).Get("state"))

			_, err := conn.Finish(t.Context(), state, code)

			require.Error(t, err)
			assert.Nil(t, store.current())
			assert.NotContains(t, err.Error(), "good-code")
			assert.NotContains(t, err.Error(), "gh-secret")
		})
	}
}

func TestGitHub_Finish_AStateWorksOnce(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn := newGitHubConn(t, gh, &ghTokens{})
	state := ghBegin(t, conn, gh).Get("state")

	_, err := conn.Finish(t.Context(), state, "good-code")
	require.NoError(t, err)
	_, err = conn.Finish(t.Context(), state, "good-code")

	require.ErrorIs(t, err, oauth.ErrInvalidState)
}

func TestGitHub_Finish_StoresNothingWhenTheAccountCannotBeRead(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	gh.userFails = true
	store := &ghTokens{}
	conn := newGitHubConn(t, gh, store)
	q := ghBegin(t, conn, gh)

	_, err := conn.Finish(t.Context(), q.Get("state"), "good-code")

	require.ErrorIs(t, err, oauth.ErrAccount)
	assert.Nil(t, store.current())
}

func TestGitHub_Bearer_NotConnectedIsNotOK(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn := newGitHubConn(t, gh, &ghTokens{})

	_, ok := conn.Bearer(t.Context())

	assert.False(t, ok)
}

func TestGitHub_Bearer_AnExpiredTokenRefreshesOnceAndTheRotatedPairIsSavedBeforeUse(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	store := &ghTokens{instance: gh.server.URL, token: &oauth2.Token{
		AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newGitHubConn(t, gh, store)
	bearer, ok := conn.Bearer(t.Context())
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

	assert.Equal(t, 1, gh.refreshCount(), "GitHub voids the old refresh token, so it is spent once")
	assert.Equal(t, "ghr-2", store.current().RefreshToken)
	for _, tok := range got {
		assert.Equal(t, "ghu-2", tok)
	}
}

func TestGitHub_Bearer_ASecondCallerSharesTheSourceSoARefreshTokenIsNeverSpentTwice(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	store := &ghTokens{instance: gh.server.URL, token: &oauth2.Token{
		AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newGitHubConn(t, gh, store)

	first, _ := conn.Bearer(t.Context())
	_, err := first()
	require.NoError(t, err)
	second, ok := conn.Bearer(t.Context())
	require.True(t, ok)
	_, err = second()
	require.NoError(t, err)

	assert.Equal(t, 1, gh.refreshCount())
}

func TestGitHub_Bearer_RefusesAPairGrantedByAnotherHost(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	store := &ghTokens{instance: "https://evil.example.com", token: &oauth2.Token{
		AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: time.Now().Add(-time.Minute),
	}}
	conn := newGitHubConn(t, gh, store)

	_, ok := conn.Bearer(t.Context())

	assert.False(t, ok, "neither the token nor the client secret goes to a host that didn't grant it")
	assert.Zero(t, gh.refreshCount())
}

func TestGitHub_Disconnect_DeletesThePairAndForgetsTheLink(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn, store := linkedGitHub(t, gh, time.Now().Add(time.Hour))

	require.NoError(t, conn.Disconnect(t.Context()))

	assert.Nil(t, store.current())
	_, ok := conn.Bearer(t.Context())
	assert.False(t, ok)
}

func linkedGitHub(t *testing.T, gh *fakeGitHub, expiry time.Time) (*oauth.GitHub, *ghTokens) {
	t.Helper()

	store := &ghTokens{instance: gh.server.URL, token: &oauth2.Token{
		AccessToken: "ghu-1", RefreshToken: "ghr-1", Expiry: expiry,
	}}
	gh.holds = func() bool { return store.current() != nil }

	return newGitHubConn(t, gh, store), store
}

func TestGitHub_Disconnect_RevokesTheGrantOnceBeforeDeletingThePair(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn, store := linkedGitHub(t, gh, time.Now().Add(time.Hour))

	require.NoError(t, conn.Disconnect(t.Context()))

	calls := gh.grantCalls()
	require.Len(t, calls, 1)
	assert.Equal(t, grantCall{
		path: "DELETE /applications/gh-id/grant", user: "gh-id", secret: "gh-secret",
		token: "ghu-1", stillStored: true,
	}, calls[0])
	assert.Nil(t, store.current())
}

func TestGitHub_Disconnect_RevokesWithAFreshTokenWhenTheStoredOneExpired(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn, store := linkedGitHub(t, gh, time.Now().Add(-time.Minute))

	require.NoError(t, conn.Disconnect(t.Context()))

	calls := gh.grantCalls()
	require.Len(t, calls, 1)
	assert.Equal(t, "ghu-2", calls[0].token)
	assert.Nil(t, store.current())
}

func TestGitHub_Disconnect_StillDeletesThePairWhenGitHubRefusesAndSaysSo(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	gh.grantStatus = http.StatusInternalServerError
	conn, store := linkedGitHub(t, gh, time.Now().Add(time.Hour))

	err := conn.Disconnect(t.Context())

	require.ErrorIs(t, err, oauth.ErrNotRevoked)
	assert.NotContains(t, err.Error(), "ghu-1")
	assert.NotContains(t, err.Error(), "gh-secret")
	assert.Len(t, gh.grantCalls(), 1, "no retry")
	assert.Nil(t, store.current())
}

func TestGitHub_Disconnect_StillDeletesThePairWhenGitHubIsUnreachable(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn, store := linkedGitHub(t, gh, time.Now().Add(time.Hour))
	gh.server.Close()

	require.ErrorIs(t, conn.Disconnect(t.Context()), oauth.ErrNotRevoked)
	assert.Nil(t, store.current())
}

func TestGitHub_Disconnect_NeverFollowsARedirectOnTheRevokeCall(t *testing.T) {
	t.Parallel()

	var hit bool
	elsewhere := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	t.Cleanup(elsewhere.Close)
	gh := newFakeGitHub(t)
	gh.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL, http.StatusTemporaryRedirect)
	})
	conn, store := linkedGitHub(t, gh, time.Now().Add(time.Hour))

	require.ErrorIs(t, conn.Disconnect(t.Context()), oauth.ErrNotRevoked)
	assert.False(t, hit)
	assert.Nil(t, store.current())
}

func TestGitHub_Disconnect_NothingToRevokeWhenNotLinked(t *testing.T) {
	t.Parallel()

	gh := newFakeGitHub(t)
	conn := newGitHubConn(t, gh, &ghTokens{})

	require.NoError(t, conn.Disconnect(t.Context()))
	assert.Empty(t, gh.grantCalls())
}

func TestGitHub_TokenRequests_NeverFollowARedirect(t *testing.T) {
	t.Parallel()

	hit := false
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		hit = true
	}))
	t.Cleanup(target.Close)
	redirecting := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/steal", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirecting.Close)

	conn := oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghRedirect, &ghTokens{},
		oauth.GitHubURLs{Web: redirecting.URL, API: redirecting.URL})
	u, err := url.Parse(conn.Begin())
	require.NoError(t, err)

	_, err = conn.Finish(t.Context(), u.Query().Get("state"), "good-code")

	require.Error(t, err)
	assert.False(t, hit, "the code, verifier and client secret must not follow a redirect")
}

func TestGitHub_Configured_IsFalseWithoutAClient(t *testing.T) {
	t.Parallel()

	var conn *oauth.GitHub

	assert.False(t, conn.Configured())
	assert.False(t, oauth.NewGitHub(t.Context(), "", "", ghRedirect, &ghTokens{}).Configured())
	assert.True(t, oauth.NewGitHub(t.Context(), "a", "b", ghRedirect, &ghTokens{}).Configured())
}
