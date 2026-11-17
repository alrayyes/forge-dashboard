package api_test

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	connRedirect  = testOrigin + "/api/v1/connections/forgejo/callback"
	connAccessTok = "access-token-SECRET-1"
	connRefreshTk = "refresh-token-SECRET-1"
)

// fakeForgejoInstance serves the OAuth endpoints and the account read.
type fakeForgejoInstance struct {
	server    *httptest.Server
	mu        sync.Mutex
	challenge string
}

func newFakeForgejoInstance(t *testing.T) *fakeForgejoInstance {
	t.Helper()

	f := &fakeForgejoInstance{}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()

		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if r.PostForm.Get("code") != "good-code" ||
			r.PostForm.Get("redirect_uri") != connRedirect ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)

			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": connAccessTok, "refresh_token": connRefreshTk, "token_type": "bearer", "expires_in": 3600,
		})
	})
	mux.HandleFunc("/api/v1/user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+connAccessTok {
			http.Error(w, "no", http.StatusUnauthorized)

			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"login": "alice"})
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)

	return f
}

type connFixture struct {
	srv    *httptest.Server
	cookie *http.Cookie
	forge  *fakeForgejoInstance
	db     *sql.DB
}

func newConnFixture(t *testing.T, configured bool) *connFixture {
	t.Helper()

	srv, _, _, _, db, _ := newTestServerWithDatabase(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0,
		func(d *api.Deps) {
			if configured {
				d.ForgejoOAuth = oauth.NewForgejo(t.Context(), "client-id", "client-secret", connRedirect, d.SettingsStore)
			}
		})
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return &connFixture{srv: srv, cookie: cookie, forge: newFakeForgejoInstance(t), db: db}
}

func (c *connFixture) start(t *testing.T, instance string) (int, map[string]any) {
	t.Helper()

	resp := doJSON(t, http.MethodPost, c.srv.URL+"/api/v1/connections/forgejo", `{"instanceUrl":"`+instance+`"}`, c.cookie)
	defer func() { _ = resp.Body.Close() }()
	var body map[string]any
	require.NoError(t, readJSON(resp, &body))

	return resp.StatusCode, body
}

// begin starts a sign-in against the fake instance and returns its state.
func (c *connFixture) begin(t *testing.T) string {
	t.Helper()

	status, body := c.start(t, c.forge.server.URL)
	require.Equal(t, http.StatusOK, status, "%v", body)
	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)
	c.forge.mu.Lock()
	c.forge.challenge = u.Query().Get("code_challenge")
	c.forge.mu.Unlock()

	return u.Query().Get("state")
}

// callback is what the browser does when the instance sends it back. It does
// not follow the redirect.
func (c *connFixture) callback(t *testing.T, query string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, c.srv.URL+"/api/v1/connections/forgejo/callback?"+query, nil)
	require.NoError(t, err)
	req.AddCookie(c.cookie)
	client := testClient(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	return resp
}

func (c *connFixture) connect(t *testing.T) {
	t.Helper()

	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(c.begin(t)))
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
}

func (c *connFixture) disconnect(t *testing.T) int {
	t.Helper()

	resp := doJSON(t, http.MethodDelete, c.srv.URL+"/api/v1/connections/forgejo", "", c.cookie)
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode
}

func (c *connFixture) storedRows(t *testing.T) int {
	t.Helper()

	var n int
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM oauth_tokens`).Scan(&n))

	return n
}

func TestConnections_RequireASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for method, path := range map[string]string{
		http.MethodPost:   "/api/v1/connections/forgejo",
		http.MethodDelete: "/api/v1/connections/forgejo",
	} {
		resp := doJSON(t, method, srv.URL+path, `{}`, nil)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, method)
	}

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/connections/forgejo/callback?code=x&state=y", "", nil)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestConnectionsStart_WithoutAnOAuthClient_Is400(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, false)
	status, _ := c.start(t, "https://git.example.com")

	assert.Equal(t, http.StatusBadRequest, status)
	assert.False(t, getSettings(t, c.srv.URL, c.cookie).ForgejoOAuthConfigured)
}

func TestConnectionsStart_RefusesURLsThatCouldCarryACredentialNamingTheField(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	for _, raw := range []string{"", "https://user:s3cret@git.example.com", "https://git.example.com/?token=abc", "ftp://git.example.com", "git.example.com"} {
		status, body := c.start(t, raw)
		assert.Equal(t, http.StatusBadRequest, status, raw)
		assert.Equal(t, "instanceUrl", body["field"], raw)
		assert.NotContains(t, body["error"], "s3cret")
	}
}

func TestConnectionsStart_AnswersTheConsentPageOnTheInstance(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	assert.True(t, getSettings(t, c.srv.URL, c.cookie).ForgejoOAuthConfigured)

	status, body := c.start(t, "https://git.example.com")
	require.Equal(t, http.StatusOK, status)
	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)

	assert.Equal(t, "git.example.com", u.Host)
	assert.Equal(t, connRedirect, u.Query().Get("redirect_uri"))
	assert.Equal(t, "S256", u.Query().Get("code_challenge_method"))
	assert.NotEmpty(t, u.Query().Get("state"))
}

func TestConnectionsCallback_LinksTheAccountAndNeverShowsATokenAgain(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	c.connect(t)

	got := getSettings(t, c.srv.URL, c.cookie)
	assert.True(t, got.ForgejoOAuthConnected)
	assert.Equal(t, "alice", got.ForgejoUsername)
	assert.Equal(t, c.forge.server.URL, got.ForgejoURL)
	assert.False(t, got.ForgejoTokenSet, "a linked account is not a pasted token")

	for _, path := range []string{"/api/v1/settings", "/api/v1/settings/summary"} {
		resp := doJSON(t, http.MethodGet, c.srv.URL+path, "", c.cookie)
		defer func() { _ = resp.Body.Close() }()
		raw := connBodyText(t, resp)
		assert.NotContains(t, raw, connAccessTok, path)
		assert.NotContains(t, raw, connRefreshTk, path)
	}

	var stored string
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT token FROM oauth_tokens WHERE forge = 'forgejo'`).Scan(&stored))
	assert.NotContains(t, stored, connAccessTok, "encrypted at rest")
	assert.NotContains(t, stored, connRefreshTk, "encrypted at rest")
}

func TestConnectionsCallback_RedirectsBackToSettings(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(c.begin(t)))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusSeeOther, resp.StatusCode)
	assert.Equal(t, "/settings", resp.Header.Get("Location"))
}

func TestConnectionsCallback_Is400AndStoresNothingWhenItCannotBeTrusted(t *testing.T) {
	t.Parallel()

	for name, query := range map[string]func(state string) string{
		"a wrong state":           func(string) string { return "code=good-code&state=forged" },
		"no state":                func(string) string { return "code=good-code" },
		"no code":                 func(s string) string { return "state=" + s },
		"an error from the forge": func(s string) string { return "error=access_denied&state=" + s },
		"a refused code":          func(s string) string { return "code=stolen&state=" + s },
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			c := newConnFixture(t, true)
			state := url.QueryEscape(c.begin(t))
			resp := c.callback(t, query(state))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			assert.Zero(t, c.storedRows(t), "nothing stored")
			got := getSettings(t, c.srv.URL, c.cookie)
			assert.False(t, got.ForgejoOAuthConnected)
			assert.Empty(t, got.ForgejoURL)
		})
	}
}

func TestConnectionsCallback_ADifferentVerifierThanTheChallengeIs400(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	state := c.begin(t)
	c.forge.mu.Lock()
	c.forge.challenge = "someone-elses-challenge"
	c.forge.mu.Unlock()

	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(state))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Zero(t, c.storedRows(t))
}

func TestConnectionsCallback_AStateCannotBeReplayed(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	state := url.QueryEscape(c.begin(t))
	first := c.callback(t, "code=good-code&state="+state)
	defer func() { _ = first.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, first.StatusCode)
	require.Equal(t, http.StatusNoContent, c.disconnect(t))

	resp := c.callback(t, "code=good-code&state="+state)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Zero(t, c.storedRows(t))
}

func TestConnectionsStart_WhileConnected_Is409(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	c.connect(t)

	status, _ := c.start(t, "https://other.example.com")

	assert.Equal(t, http.StatusConflict, status)
}

func TestSettingsPut_WhileConnected_RefusesAnotherForgejoURL(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	c.connect(t)

	status, body := putSettings(t, c.srv.URL, `{"forgejoUrl":"https://elsewhere.example.com","forgejoUsername":"alice"}`, c.cookie)

	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "forgejoUrl", body["field"])
	assert.Equal(t, c.forge.server.URL, getSettings(t, c.srv.URL, c.cookie).ForgejoURL, "the token never follows the URL to another host")

	status, _ = putSettings(t, c.srv.URL, `{"forgejoUrl":"`+c.forge.server.URL+`","forgejoUsername":"alice"}`, c.cookie)
	assert.Equal(t, http.StatusOK, status, "saving the other settings still works")
}

func TestConnectionsDelete_DeletesTheTokensAndClearsTheInstance(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	c.connect(t)

	require.Equal(t, http.StatusNoContent, c.disconnect(t))

	got := getSettings(t, c.srv.URL, c.cookie)
	assert.False(t, got.ForgejoOAuthConnected)
	assert.Empty(t, got.ForgejoURL)
	assert.Empty(t, got.ForgejoUsername)
	assert.Zero(t, c.storedRows(t))
	assert.Equal(t, http.StatusNoContent, c.disconnect(t), "disconnecting twice is fine")
}

func TestConnectionsDelete_FallsBackToThePastedToken(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	status, _ := putSettings(t, c.srv.URL, `{"forgejoUrl":"`+c.forge.server.URL+`","forgejoToken":"pasted","forgejoUsername":"alice"}`, c.cookie)
	require.Equal(t, http.StatusOK, status)
	c.connect(t)

	require.Equal(t, http.StatusNoContent, c.disconnect(t))

	got := getSettings(t, c.srv.URL, c.cookie)
	assert.False(t, got.ForgejoOAuthConnected)
	assert.True(t, got.ForgejoTokenSet)
	assert.Equal(t, c.forge.server.URL, got.ForgejoURL)
	assert.Equal(t, "alice", got.ForgejoUsername)
}

func TestConnectionsDelete_LeavesPasskeySignInAlone(t *testing.T) {
	t.Parallel()

	c := newConnFixture(t, true)
	c.connect(t)
	require.Equal(t, http.StatusNoContent, c.disconnect(t))

	resp := doJSON(t, http.MethodGet, c.srv.URL+"/api/v1/auth/session", "", c.cookie)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func connBodyText(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer func() { _ = resp.Body.Close() }()

	var sb strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}

	return sb.String()
}

// Not parallel: it swaps the process-wide logger to read what the handlers log.
func TestConnections_NeverLogOrAnswerWithACodeStateSecretOrToken(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	c := newConnFixture(t, true)
	state := c.begin(t)
	refused := c.callback(t, "code=stolen-code&state="+url.QueryEscape(state))
	defer func() { _ = refused.Body.Close() }()
	refusedBody := connBodyText(t, refused)
	c.connect(t)
	replayed := c.callback(t, "code=good-code&state=replayed")
	defer func() { _ = replayed.Body.Close() }()

	for _, secret := range []string{"stolen-code", "good-code", state, "client-secret", connAccessTok, connRefreshTk} {
		assert.NotContains(t, logs.String(), secret, "log")
		assert.NotContains(t, refusedBody, secret, "answer")
	}
}
