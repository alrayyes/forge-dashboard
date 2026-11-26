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
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	ghConnRedirect = testOrigin + "/api/v1/connections/github/callback"
	ghAccessTok    = "ghu_ACCESS-SECRET-1"
	ghRefreshTok   = "ghr_REFRESH-SECRET-1"
)

// fakeGitHubHost serves GitHub's token endpoint and GET /user.
type fakeGitHubHost struct {
	server    *httptest.Server
	mu        sync.Mutex
	challenge string
}

func newFakeGitHubHost(t *testing.T) *fakeGitHubHost {
	t.Helper()

	f := &fakeGitHubHost{}
	mux := http.NewServeMux()
	mux.HandleFunc("/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f.mu.Lock()
		defer f.mu.Unlock()

		sum := sha256.Sum256([]byte(r.PostForm.Get("code_verifier")))
		if r.PostForm.Get("code") != "good-code" ||
			r.PostForm.Get("redirect_uri") != ghConnRedirect ||
			base64.RawURLEncoding.EncodeToString(sum[:]) != f.challenge {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{
				"error":             "bad_verification_code",
				"error_description": "denied " + r.PostForm.Get("code") + " " + r.PostForm.Get("client_secret") + " " + r.PostForm.Get("code_verifier"),
			})

			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": ghAccessTok, "refresh_token": ghRefreshTok, "token_type": "bearer",
			"expires_in": 28800, "refresh_token_expires_in": 15811200,
		})
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+ghAccessTok {
			http.Error(w, "no", http.StatusUnauthorized)

			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"login": "octocat"})
	})
	mux.HandleFunc("/user/installations", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+ghAccessTok {
			http.Error(w, "no", http.StatusUnauthorized)

			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"total_count": 2,
			"installations": []map[string]any{
				{"id": 100, "account": map[string]string{"login": "octocat"}},
				{"id": 200, "account": map[string]string{"login": "acme-org"}},
			},
		})
	})
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)

	return f
}

type ghConnFixture struct {
	srv    *httptest.Server
	cookie *http.Cookie
	gh     *fakeGitHubHost
	db     *sql.DB
	builds *atomic.Int32
}

func newGHConnFixture(t *testing.T, configured bool) *ghConnFixture {
	t.Helper()

	gh := newFakeGitHubHost(t)
	builds := &atomic.Int32{}
	srv, _, _, _, db, _ := newTestServerWithDatabase(t, func(settingspkg.Credentials) []dashboard.Source { builds.Add(1); return nil }, false, 0,
		func(d *api.Deps) {
			if configured {
				d.GitHubOAuth = oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghConnRedirect, d.SettingsStore,
					oauth.GitHubURLs{Web: gh.server.URL, API: gh.server.URL})
			}
		})
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return &ghConnFixture{srv: srv, cookie: cookie, gh: gh, db: db, builds: builds}
}

func (c *ghConnFixture) start(t *testing.T) (int, map[string]any, http.Header) {
	t.Helper()

	resp := doJSON(t, http.MethodPost, c.srv.URL+"/api/v1/connections/github", "", c.cookie)
	defer func() { _ = resp.Body.Close() }()
	var body map[string]any
	_ = readJSON(resp, &body)

	return resp.StatusCode, body, resp.Header
}

func (c *ghConnFixture) begin(t *testing.T) string {
	t.Helper()

	status, body, _ := c.start(t)
	require.Equal(t, http.StatusOK, status, "%v", body)
	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)
	c.gh.mu.Lock()
	c.gh.challenge = u.Query().Get("code_challenge")
	c.gh.mu.Unlock()

	return u.Query().Get("state")
}

func (c *ghConnFixture) callback(t *testing.T, query string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, c.srv.URL+"/api/v1/connections/github/callback?"+query, nil)
	require.NoError(t, err)
	req.AddCookie(c.cookie)
	client := testClient(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	return resp
}

func (c *ghConnFixture) connect(t *testing.T) {
	t.Helper()

	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(c.begin(t)))
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
}

func (c *ghConnFixture) rows(t *testing.T) int {
	t.Helper()

	var n int
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM oauth_tokens WHERE forge = 'github'`).Scan(&n))

	return n
}

func TestGitHubConnections_RequireASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for method, path := range map[string]string{
		http.MethodPost:   "/api/v1/connections/github",
		http.MethodDelete: "/api/v1/connections/github",
	} {
		resp := doJSON(t, method, srv.URL+path, ``, nil)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, method)
	}

	resp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/connections/github/callback?code=x&state=y", "", nil)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGitHubConnectionsStart_WithoutAnOAuthClient_Is400(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, false)
	status, _, _ := c.start(t)

	assert.Equal(t, http.StatusBadRequest, status)
	assert.False(t, getSettings(t, c.srv.URL, c.cookie).GitHubOAuthConfigured)
}

func TestGitHubConnectionsStart_AnswersTheConsentPageWithPKCEAndNoStore(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	status, body, header := c.start(t)

	require.Equal(t, http.StatusOK, status)
	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)
	assert.Equal(t, "S256", u.Query().Get("code_challenge_method"))
	assert.Equal(t, ghConnRedirect, u.Query().Get("redirect_uri"))
	assert.Equal(t, "no-store", header.Get("Cache-Control"))
	assert.True(t, getSettings(t, c.srv.URL, c.cookie).GitHubOAuthConfigured)
}

func TestGitHubConnectionsCallback_LinksTheAccountAndNeverShowsATokenAgain(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)

	assert.True(t, getSettings(t, c.srv.URL, c.cookie).GitHubOAuthConnected)
	for _, path := range []string{"/api/v1/settings", "/api/v1/settings/summary"} {
		resp := doJSON(t, http.MethodGet, c.srv.URL+path, "", c.cookie)
		defer func() { _ = resp.Body.Close() }()
		raw := connBodyText(t, resp)
		assert.NotContains(t, raw, ghAccessTok, path)
		assert.NotContains(t, raw, ghRefreshTok, path)
		assert.Contains(t, raw, `"githubOAuthConnected":true`, path)
	}

	var stored string
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT token FROM oauth_tokens WHERE forge = 'github'`).Scan(&stored))
	assert.NotContains(t, stored, ghAccessTok, "encrypted at rest")
	assert.NotContains(t, stored, ghRefreshTok, "encrypted at rest")
}

func TestGitHubConnectionsSettings_ReportTheLinkedLoginAndNeverAToken(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	assert.Empty(t, getSettings(t, c.srv.URL, c.cookie).GitHubLogin, "no account linked yet")

	c.connect(t)

	assert.Equal(t, "octocat", getSettings(t, c.srv.URL, c.cookie).GitHubLogin)
	for _, path := range []string{"/api/v1/settings", "/api/v1/settings/summary"} {
		resp := doJSON(t, http.MethodGet, c.srv.URL+path, "", c.cookie)
		defer func() { _ = resp.Body.Close() }()
		raw := connBodyText(t, resp)
		assert.Contains(t, raw, `"githubLogin":"octocat"`, path)
		assert.NotContains(t, raw, ghAccessTok, path)
	}
}

func TestGitHubConnectionsCallback_RedirectsBackToTheSetupPageAndIsNeverCached(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(c.begin(t)))
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusSeeOther, resp.StatusCode)
	assert.Equal(t, "/setup", resp.Header.Get("Location"))
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))

	refused := c.callback(t, "code=x&state=forged")
	defer func() { _ = refused.Body.Close() }()
	assert.Equal(t, "no-store", refused.Header.Get("Cache-Control"))
}

func TestGitHubConnectionsCallback_SendsTheBrowserBackWithACodeAndStoresNothingWhenItCannotBeTrusted(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		query func(state string) string
		code  string
	}{
		"a wrong state":           {func(string) string { return "code=good-code&state=forged" }, "invalid_state"},
		"no state":                {func(string) string { return "code=good-code" }, "invalid_state"},
		"no code":                 {func(s string) string { return "state=" + s }, "invalid_state"},
		"an error from the forge": {func(s string) string { return "error=access_denied&state=" + s }, "access_denied"},
		"a refused code":          {func(s string) string { return "code=stolen&state=" + s }, "exchange_failed"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			c := newGHConnFixture(t, true)
			resp := c.callback(t, tc.query(url.QueryEscape(c.begin(t))))
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusSeeOther, resp.StatusCode)
			assert.Equal(t, tc.code, setupErrorOf(t, resp))
			assert.Zero(t, c.rows(t))
			assert.False(t, getSettings(t, c.srv.URL, c.cookie).GitHubOAuthConnected)
		})
	}
}

func TestGitHubConnectionsCallback_AStateCannotBeReplayedAndAVerifierMustMatch(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	state := url.QueryEscape(c.begin(t))
	first := c.callback(t, "code=good-code&state="+state)
	defer func() { _ = first.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, first.StatusCode)
	require.Equal(t, http.StatusNoContent, ghDisconnect(t, c))

	replay := c.callback(t, "code=good-code&state="+state)
	defer func() { _ = replay.Body.Close() }()
	assert.Equal(t, "invalid_state", setupErrorOf(t, replay))

	other := c.begin(t)
	c.gh.mu.Lock()
	c.gh.challenge = "someone-elses-challenge"
	c.gh.mu.Unlock()
	wrong := c.callback(t, "code=good-code&state="+url.QueryEscape(other))
	defer func() { _ = wrong.Body.Close() }()
	assert.Equal(t, "exchange_failed", setupErrorOf(t, wrong))
	assert.Zero(t, c.rows(t))
}

func ghDisconnect(t *testing.T, c *ghConnFixture) int {
	t.Helper()

	resp := doJSON(t, http.MethodDelete, c.srv.URL+"/api/v1/connections/github", "", c.cookie)
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode
}

func TestGitHubConnectionsStart_WhileConnected_Is409(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)
	status, _, _ := c.start(t)

	assert.Equal(t, http.StatusConflict, status)
}

func TestGitHubConnectionsDelete_DeletesThePairAndLeavesTheOtherSettingsAlone(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)
	resp := doJSON(t, http.MethodPut, c.srv.URL+"/api/v1/settings", `{"githubUsername":"octocat"}`, c.cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.Equal(t, http.StatusNoContent, ghDisconnect(t, c))

	got := getSettings(t, c.srv.URL, c.cookie)
	assert.False(t, got.GitHubOAuthConnected)
	assert.Equal(t, "octocat", got.GitHubUsername)
	assert.Zero(t, c.rows(t))
	assert.Equal(t, http.StatusNoContent, ghDisconnect(t, c), "nothing to disconnect is still fine")
}

func TestGitHubConnectionsDelete_WorksWithNoClientConfiguredAnyMore(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, false)
	_, err := c.db.ExecContext(t.Context(), `INSERT INTO oauth_tokens (forge, token, updated_at) VALUES ('github', 'x', CURRENT_TIMESTAMP)`)
	require.NoError(t, err)

	assert.Equal(t, http.StatusNoContent, ghDisconnect(t, c))
	assert.Zero(t, c.rows(t))
}

// Not parallel: it swaps the process-wide logger to read what the handlers log.
func TestGitHubConnections_NeverLogOrAnswerWithACodeStateSecretOrToken(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previous) })

	c := newGHConnFixture(t, true)
	state := c.begin(t)
	refused := c.callback(t, "code=stolen-code&state="+url.QueryEscape(state))
	defer func() { _ = refused.Body.Close() }()
	refusedBody := connBodyText(t, refused)
	c.connect(t)

	for _, secret := range []string{"stolen-code", "good-code", state, "gh-secret", ghAccessTok, ghRefreshTok} {
		assert.NotContains(t, logs.String(), secret, "log")
		assert.NotContains(t, refusedBody, secret, "answer")
	}
}

func TestGitHubConnections_LinkingRebuildsTheRunningSources(t *testing.T) {
	c := newGHConnFixture(t, true)
	before := c.builds.Load()

	c.connect(t)

	assert.Greater(t, c.builds.Load(), before)
}

func TestGitHubConnections_DisconnectingRebuildsTheRunningSources(t *testing.T) {
	c := newGHConnFixture(t, true)
	c.connect(t)
	before := c.builds.Load()

	resp := doJSON(t, http.MethodDelete, c.srv.URL+"/api/v1/connections/github", "", c.cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.Greater(t, c.builds.Load(), before)
}
