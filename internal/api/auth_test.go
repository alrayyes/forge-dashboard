package api_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	authpkg "github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	sharingpkg "github.com/alrayyes/forge-dashboard/internal/sharing"
	"github.com/descope/virtualwebauthn"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

const (
	testRPID    = "localhost"
	testOrigin  = "http://localhost"
	testAdmin   = "admin"
	testUser    = "ryan"
	testDisplay = "Ryan"
	testVersion = "0.99.0-test"

	// Fast enough that require.Eventually in these tests doesn't have to
	// wait long, slow enough not to burn CPU spinning between assertions.
	testRefreshInterval = 10 * time.Millisecond
)

// noSources is the default Deps.BuildSources for tests that don't care
// about real forge data — most of this file, which is about the auth and
// settings plumbing, not internal/github or internal/forgejo (each tested
// in its own package).
func noSources(settingspkg.Credentials) []dashboard.Source { return nil }

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	return newTestServerWithSources(t, noSources)
}

func newTestServerWithSources(t *testing.T, buildSources func(settingspkg.Credentials) []dashboard.Source) *httptest.Server {
	t.Helper()
	srv, _ := newTestServerWithSourcesAndManager(t, buildSources)

	return srv
}

// newTestServerWithSourcesAndManager is newTestServerWithSources plus the
// *dashboard.Manager itself — for a test that needs to simulate a process
// restart (manager.Stop(), which cancels every running loop and clears
// its map, the same effect on Manager state a real restart has) without
// tearing down the rest of the server.
func newTestServerWithSourcesAndManager(t *testing.T, buildSources func(settingspkg.Credentials) []dashboard.Source) (*httptest.Server, *dashboard.Manager) {
	t.Helper()

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	authStore := authpkg.NewStore(db)
	require.NoError(t, authStore.Init(t.Context()))

	wa, err := webauthn.New(&webauthn.Config{
		RPID:          testRPID,
		RPDisplayName: "Forge Board Test",
		RPOrigins:     []string{testOrigin},
	})
	require.NoError(t, err)
	authService := authpkg.NewService(wa, authStore)

	cipher, err := settingspkg.NewCipher(testEncryptionKey(t))
	require.NoError(t, err)
	settingsStore := settingspkg.NewStore(db, cipher)
	require.NoError(t, settingsStore.Init(t.Context()))

	sharingStore := sharingpkg.NewStore(db)
	require.NoError(t, sharingStore.Init(t.Context()))

	manager := dashboard.NewManager(testRefreshInterval)
	t.Cleanup(manager.Stop)

	appCtx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	mux := api.NewMux(api.Deps{
		Version:       testVersion,
		AuthService:   authService,
		AuthStore:     authStore,
		SettingsStore: settingsStore,
		SharingStore:  sharingStore,
		Manager:       manager,
		BuildSources:  buildSources,
		AppContext:    appCtx,
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, manager
}

func testEncryptionKey(t *testing.T) string {
	t.Helper()
	key := make([]byte, 32)
	_, err := rand.Read(key)
	require.NoError(t, err)

	return base64.StdEncoding.EncodeToString(key)
}

// registerViaRealCeremony drives a full registration through the actual
// HTTP handlers using a virtual WebAuthn authenticator (real crypto, real
// attestation — not a mock of forge-dashboard's own code) and returns the
// session cookie the server issued.
func registerViaRealCeremony(t *testing.T, srv *httptest.Server, username, displayName string) (*http.Cookie, virtualwebauthn.Credential, virtualwebauthn.Authenticator) {
	t.Helper()

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	beginBody := strings.NewReader(`{"username":"` + username + `","displayName":"` + displayName + `"}`)
	beginResp, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", beginBody)
	require.NoError(t, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(t, http.StatusOK, beginResp.StatusCode)

	optionsJSON, err := io.ReadAll(beginResp.Body)
	require.NoError(t, err)

	attestationOptions, err := virtualwebauthn.ParseAttestationOptions(string(optionsJSON))
	require.NoError(t, err)
	require.NotNil(t, attestationOptions)

	attestationResponse := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOptions)

	finishResp, err := http.Post(
		srv.URL+"/api/auth/register/finish?username="+username,
		"application/json",
		strings.NewReader(attestationResponse),
	)
	require.NoError(t, err)
	defer func() { _ = finishResp.Body.Close() }()
	require.Equal(t, http.StatusOK, finishResp.StatusCode, "register/finish body: %s", readAll(t, finishResp))

	// No UserHandle set on the authenticator: this account's real WebAuthn
	// user ID is a random 32 bytes assigned at registration, not something
	// this test fixture can predict, so the virtual authenticator leaves
	// the assertion's userHandle empty rather than sending one that
	// wouldn't match — a non-discoverable login (this server never calls
	// BeginDiscoverableLogin) doesn't need it, since the server already
	// knows which user it's validating against from the ceremony it
	// started.
	authenticator.AddCredential(cred)

	for _, c := range finishResp.Cookies() {
		if c.Name == authpkg.CookieName {
			return c, cred, authenticator
		}
	}
	t.Fatal("no session cookie set by register/finish")

	return nil, cred, authenticator
}

func readAll(t *testing.T, resp *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return string(b)
}

func TestPasskeyRegistrationAndLogin_RealWebAuthnCeremony(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	sessionCookie, cred, authenticator := registerViaRealCeremony(t, srv, testUser, testDisplay)
	require.NotEmpty(t, sessionCookie.Value)

	t.Run("the session from registration reaches the protected dashboard", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
		require.NoError(t, err)
		req.AddCookie(sessionCookie)

		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("the dashboard refuses a request with no session at all", func(t *testing.T) {
		resp, err := http.Get(srv.URL + "/api/dashboard")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("logging in again with the same passkey issues a new working session", func(t *testing.T) {
		rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}

		beginResp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`"}`))
		require.NoError(t, err)
		defer func() { _ = beginResp.Body.Close() }()
		require.Equal(t, http.StatusOK, beginResp.StatusCode)

		optionsJSON, err := io.ReadAll(beginResp.Body)
		require.NoError(t, err)

		assertionOptions, err := virtualwebauthn.ParseAssertionOptions(string(optionsJSON))
		require.NoError(t, err)

		found := authenticator.FindAllowedCredential(*assertionOptions)
		require.NotNil(t, found)

		assertionResponse := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *assertionOptions)

		finishResp, err := http.Post(
			srv.URL+"/api/auth/login/finish?username="+testUser,
			"application/json",
			strings.NewReader(assertionResponse),
		)
		require.NoError(t, err)
		defer func() { _ = finishResp.Body.Close() }()
		require.Equal(t, http.StatusOK, finishResp.StatusCode, "login/finish body: %s", readAll(t, finishResp))

		var loginCookie *http.Cookie
		for _, c := range finishResp.Cookies() {
			if c.Name == authpkg.CookieName {
				loginCookie = c
			}
		}
		require.NotNil(t, loginCookie)

		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
		require.NoError(t, err)
		req.AddCookie(loginCookie)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
}

func TestPasskeyRegistration_FirstUserBecomesAdmin(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	var body api.SessionUser
	require.NoError(t, readJSON(resp, &body))
	assert.True(t, body.IsAdmin)
}

func TestPasskeyRegistration_SecondUserIsNotAdmin(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	registerViaRealCeremony(t, srv, testAdmin, "Admin") // first registrant becomes admin
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	var body api.SessionUser
	require.NoError(t, readJSON(resp, &body))
	assert.False(t, body.IsAdmin)
}

func TestLogout_ClearsTheSession(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/logout", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	req2, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req2.AddCookie(sessionCookie)
	resp2, err := http.DefaultClient.Do(req2)
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)
}

func TestRegisterBegin_DuplicateUsername_Conflicts(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`","displayName":"Someone Else"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, http.StatusConflict, resp.StatusCode)
}

// Real bug, reported live: a reload between register/begin and
// register/finish (before the passkey prompt completes) used to leave a
// username permanently claimed with no credential attached — every retry
// hit 409, and login/begin 500'd since there was nothing to log in with.
func TestRegisterBegin_AbandonedRegistration_CanBeRetried(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp1, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`","displayName":"`+testDisplay+`"}`))
	require.NoError(t, err)
	_ = resp1.Body.Close()
	require.Equal(t, http.StatusOK, resp1.StatusCode)

	resp2, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`","displayName":"`+testDisplay+`"}`))
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusOK, resp2.StatusCode)
}

func TestLoginBegin_AbandonedRegistration_ReturnsNotFoundNotServerError(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`","displayName":"`+testDisplay+`"}`))
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	loginResp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"`+testUser+`"}`))
	require.NoError(t, err)
	defer func() { _ = loginResp.Body.Close() }()
	assert.Equal(t, http.StatusNotFound, loginResp.StatusCode)
}
