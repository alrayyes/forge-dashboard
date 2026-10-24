package api_test

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	authpkg "github.com/alrayyes/forge-dashboard/internal/auth"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/dbdsn"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/descope/virtualwebauthn"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

const (
	testRPID      = "localhost"
	testOrigin    = "http://localhost"
	testAdmin     = "admin"
	testUser      = "ryan"
	testOwner     = "owner"
	testOtherUser = "alex"
	testDisplay   = "Ryan"
	testVersion   = "0.99.0-test"

	// Fast enough that require.Eventually in these tests doesn't have to
	// wait long, slow enough not to burn CPU spinning between assertions.
	testRefreshInterval = 10 * time.Millisecond
)

// noSources is the default Deps.BuildSources for tests that don't care
// about real forge data — most of this file, which is about the auth and
// settings plumbing, not internal/github or internal/forgejo (each tested
// in its own package).
func noSources(settingspkg.Credentials) []dashboard.Source { return nil }

func newTestServer(tb testing.TB) *httptest.Server {
	tb.Helper()

	return newTestServerWithSources(tb, noSources)
}

func newTestServerWithSources(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source) *httptest.Server {
	tb.Helper()
	srv, _, _ := newTestServerWithSourcesAndService(tb, buildSources)

	return srv
}

// newTestServerWithSourcesAndService is newTestServerWithSources plus
// the *dashboard.Service itself — for a test that needs to simulate a
// process restart (service.Stop(), which cancels every running loop and
// clears it, the same effect on Service state a real restart has)
// without tearing down the rest of the server — and the *auth.Store,
// for a test that needs to seed state (like a request-log row) with no
// HTTP endpoint of its own to create one through.
func newTestServerWithSourcesAndService(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source) (*httptest.Server, *dashboard.Service, *authpkg.Store) {
	tb.Helper()

	return newTestServerWithAutoMerge(tb, buildSources, false)
}

// newTestServerWithAutoMerge is newTestServerWithSourcesAndService with the
// auto-merge hook switched on, as main.go does: it merges armed Forgejo pull
// requests and cancels an armed auto-merge on one that went empty (#1375). Off
// elsewhere, since it reads the armed set on every refresh.
func newTestServerWithAutoMerge(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source, autoMerge bool) (*httptest.Server, *dashboard.Service, *authpkg.Store) {
	tb.Helper()

	return newTestServerWithFirstLoadWait(tb, buildSources, autoMerge, 0)
}

// newTestServerWithFirstLoadWait is newTestServerWithAutoMerge with the time a
// read waits for a user's first refresh set (zero keeps the default). A test
// holding a refresh open needs it short, or its read blocks for the default.
func newTestServerWithFirstLoadWait(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source, autoMerge bool, firstLoadWait time.Duration) (*httptest.Server, *dashboard.Service, *authpkg.Store) {
	tb.Helper()
	srv, service, authStore, _ := newTestServerWithSettingsStore(tb, buildSources, autoMerge, firstLoadWait)

	return srv, service, authStore
}

// newTestServerWithSettingsStore is newTestServerWithFirstLoadWait plus the
// *settings.Store, for a test that asserts what the store holds after a call
// (say, that a read created no webhook credentials). opts adjust the Deps before the mux is built.
func newTestServerWithSettingsStore(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source, autoMerge bool, firstLoadWait time.Duration, opts ...func(*api.Deps)) (*httptest.Server, *dashboard.Service, *authpkg.Store, *settingspkg.Store) {
	tb.Helper()
	srv, service, authStore, settingsStore, _, _ := newTestServerWithDatabase(tb, buildSources, autoMerge, firstLoadWait, opts...)

	return srv, service, authStore, settingsStore
}

// newTestServerWithDatabase is newTestServerWithSettingsStore plus the open
// database and the path of its file, for a test that runs something against
// the database the server is serving, like the single-user cleanup.
func newTestServerWithDatabase(tb testing.TB, buildSources func(settingspkg.Credentials) []dashboard.Source, autoMerge bool, firstLoadWait time.Duration, opts ...func(*api.Deps)) (*httptest.Server, *dashboard.Service, *authpkg.Store, *settingspkg.Store, *sql.DB, string) {
	tb.Helper()

	dbPath := filepath.Join(tb.TempDir(), "app.db")
	db, err := sql.Open("sqlite", dbdsn.For(dbPath))
	require.NoError(tb, err)
	tb.Cleanup(func() { _ = db.Close() })

	authStore := authpkg.NewStore(db)
	require.NoError(tb, authStore.Init(tb.Context()))

	wa, err := webauthn.New(&webauthn.Config{
		RPID:          testRPID,
		RPDisplayName: "Forge Board Test",
		RPOrigins:     []string{testOrigin},
	})
	require.NoError(tb, err)
	authService := authpkg.NewService(wa, authStore)

	cipher, err := settingspkg.NewCipher(testEncryptionKey(tb))
	require.NoError(tb, err)
	settingsStore := settingspkg.NewStore(db, cipher)
	require.NoError(tb, settingsStore.Init(tb.Context()))

	service := dashboard.NewService(testRefreshInterval)
	if autoMerge {
		service.SetAutoMergeStore(settingsStore)
	}
	tb.Cleanup(service.Stop)

	appCtx, cancel := context.WithCancel(context.Background())
	tb.Cleanup(cancel)

	deps := api.Deps{
		Version:       testVersion,
		AuthService:   authService,
		AuthStore:     authStore,
		SettingsStore: settingsStore,
		Service:       service,
		BuildSources:  buildSources,
		AppContext:    appCtx,

		FirstLoadWait: firstLoadWait,
	}
	for _, opt := range opts {
		opt(&deps)
	}
	mux := api.NewMux(deps)
	srv := httptest.NewServer(mux)
	tb.Cleanup(srv.Close)
	testStores.Store(srv.URL, authStore)
	tb.Cleanup(func() { testStores.Delete(srv.URL) })

	return srv, service, authStore, settingsStore, db, dbPath
}

func testEncryptionKey(tb testing.TB) string {
	tb.Helper()
	key := make([]byte, 32)
	_, err := rand.Read(key)
	require.NoError(tb, err)

	return base64.StdEncoding.EncodeToString(key)
}

// registerViaRealCeremony drives a full registration through the actual
// HTTP handlers using a virtual WebAuthn authenticator (real crypto, real
// attestation — not a mock of forge-dashboard's own code) and returns the
// session cookie the server issued.
func registerViaRealCeremony(tb testing.TB, srv *httptest.Server) (*http.Cookie, virtualwebauthn.Credential, virtualwebauthn.Authenticator) {
	tb.Helper()

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	authenticator := virtualwebauthn.NewAuthenticator()
	cred := virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2)

	beginResp, err := testClient(tb).Post(srv.URL+"/api/auth/register/begin", "application/json", nil)
	require.NoError(tb, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(tb, http.StatusOK, beginResp.StatusCode)

	optionsJSON, err := io.ReadAll(beginResp.Body)
	require.NoError(tb, err)

	attestationOptions, err := virtualwebauthn.ParseAttestationOptions(string(optionsJSON))
	require.NoError(tb, err)
	require.NotNil(tb, attestationOptions)

	attestationResponse := virtualwebauthn.CreateAttestationResponse(rp, authenticator, cred, *attestationOptions)

	finishResp, err := testClient(tb).Post(
		srv.URL+"/api/auth/register/finish",
		"application/json",
		strings.NewReader(attestationResponse),
	)
	require.NoError(tb, err)
	defer func() { _ = finishResp.Body.Close() }()
	require.Equal(tb, http.StatusOK, finishResp.StatusCode, "register/finish body: %s", readAll(tb, finishResp))

	// No UserHandle set on the authenticator: this account's real WebAuthn
	// user ID is a random 32 bytes assigned at registration, not something
	// this test fixture can predict, so the virtual authenticator leaves
	// the assertion's userHandle empty rather than sending one that
	// wouldn'tb match — a non-discoverable login (this server never calls
	// BeginDiscoverableLogin) doesn'tb need it, since the server already
	// knows which user it's validating against from the ceremony it
	// started.
	authenticator.AddCredential(cred)

	for _, c := range finishResp.Cookies() {
		if c.Name == authpkg.CookieName {
			return c, cred, authenticator
		}
	}
	tb.Fatal("no session cookie set by register/finish")

	return nil, cred, authenticator
}

// testStores maps a test server's URL to its auth store, so a test of owner-only
// access can add a second user the way no public flow can any more:
// registration closes once the first user holds a passkey.
var testStores sync.Map

func readAll(tb testing.TB, resp *http.Response) string {
	tb.Helper()
	b, err := io.ReadAll(resp.Body)
	require.NoError(tb, err)

	return string(b)
}

func TestPasskeyRegistrationAndLogin_RealWebAuthnCeremony(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	sessionCookie, cred, authenticator := registerViaRealCeremony(t, srv)
	require.NotEmpty(t, sessionCookie.Value)

	t.Run("the session from registration reaches the protected dashboard", func(t *testing.T) {
		req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
		require.NoError(t, err)
		req.AddCookie(sessionCookie)

		resp, err := testClient(t).Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})

	t.Run("the dashboard refuses a request with no session at all", func(t *testing.T) {
		resp, err := testClient(t).Get(srv.URL + "/api/dashboard")
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	})

	t.Run("logging in again with the same passkey issues a new working session", func(t *testing.T) {
		rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}

		beginResp, err := testClient(t).Post(srv.URL+"/api/auth/login/begin", "application/json", nil)
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

		finishResp, err := testClient(t).Post(
			srv.URL+"/api/auth/login/finish",
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
		resp, err := testClient(t).Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	})
}

func TestLogout_ClearsTheSession(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/logout", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	req2, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req2.AddCookie(sessionCookie)
	resp2, err := testClient(t).Do(req2)
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusUnauthorized, resp2.StatusCode)
}

// An instance has one owner: once a user holds a passkey, register/begin
// answers 403, whatever body an older client still sends.
func TestRegisterBegin_AfterAUserRegistered_IsClosed(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	registerViaRealCeremony(t, srv)

	for _, body := range []string{``, `{}`, `{"username":"newcomer","displayName":"Newcomer"}`} {
		resp, err := testClient(t).Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(body))
		require.NoError(t, err)
		raw := readAll(t, resp)
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusForbidden, resp.StatusCode, body)
		assert.Contains(t, raw, "registration is closed")
	}
}

// Passkeys registered before the username went away sit under a username the
// visitor picked then. Signing in asks for none, and the passkey still works.
func TestLoginBegin_OwnerRegisteredUnderAChosenUsername_StillSignsIn(t *testing.T) {
	t.Parallel()
	srv, _, _, _, db, _ := newTestServerWithDatabase(t, noSources, false, 0)
	_, cred, authenticator := registerViaRealCeremony(t, srv)
	_, err := db.ExecContext(t.Context(), `UPDATE users SET username = 'ryan', display_name = 'Ryan'`)
	require.NoError(t, err)

	cookie := loginWithPasskey(t, srv, cred, authenticator)

	assert.NotEmpty(t, cookie.Value)
}

// The registration asks the visitor for no name: the server picks one.
func TestRegisterFinish_NamesTheOwnerItself(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, testOwner, body.Username)
}

func TestLoginBegin_NobodyRegisteredYet_ReturnsNotFound(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp, err := testClient(t).Post(srv.URL+"/api/auth/login/begin", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// loginWithPasskey runs a login ceremony with no username and returns the
// session cookie the server issued.
func loginWithPasskey(tb testing.TB, srv *httptest.Server, cred virtualwebauthn.Credential, authenticator virtualwebauthn.Authenticator) *http.Cookie {
	tb.Helper()

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	beginResp, err := testClient(tb).Post(srv.URL+"/api/auth/login/begin", "application/json", nil)
	require.NoError(tb, err)
	defer func() { _ = beginResp.Body.Close() }()
	require.Equal(tb, http.StatusOK, beginResp.StatusCode)

	options, err := virtualwebauthn.ParseAssertionOptions(readAll(tb, beginResp))
	require.NoError(tb, err)
	require.NotNil(tb, authenticator.FindAllowedCredential(*options))

	finishResp, err := testClient(tb).Post(srv.URL+"/api/auth/login/finish", "application/json",
		strings.NewReader(virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *options)))
	require.NoError(tb, err)
	defer func() { _ = finishResp.Body.Close() }()
	require.Equal(tb, http.StatusOK, finishResp.StatusCode, "login/finish body: %s", readAll(tb, finishResp))

	for _, c := range finishResp.Cookies() {
		if c.Name == authpkg.CookieName {
			return c
		}
	}
	tb.Fatal("no session cookie set by login/finish")

	return nil
}

// Real bug, reported live: a reload between register/begin and
// register/finish (before the passkey prompt completes) used to leave a
// username permanently claimed with no credential attached — every retry
// hit 409, and login/begin 500'd since there was nothing to log in with.
func TestRegisterBegin_AbandonedRegistration_CanBeRetried(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp1, err := testClient(t).Post(srv.URL+"/api/auth/register/begin", "application/json", nil)
	require.NoError(t, err)
	_ = resp1.Body.Close()
	require.Equal(t, http.StatusOK, resp1.StatusCode)

	resp2, err := testClient(t).Post(srv.URL+"/api/auth/register/begin", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = resp2.Body.Close() }()
	assert.Equal(t, http.StatusOK, resp2.StatusCode)
}

func TestLoginBegin_AbandonedRegistration_ReturnsNotFoundNotServerError(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp, err := testClient(t).Post(srv.URL+"/api/auth/register/begin", "application/json", nil)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	loginResp, err := testClient(t).Post(srv.URL+"/api/auth/login/begin", "application/json", nil)
	require.NoError(t, err)
	defer func() { _ = loginResp.Body.Close() }()
	assert.Equal(t, http.StatusNotFound, loginResp.StatusCode)
}

func TestRegistrationStatus_NoUsersYet_IsOpen(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	resp, err := testClient(t).Get(srv.URL + "/api/auth/registration-status")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Open bool `json:"open"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.True(t, body.Open)
}

func TestRegistrationStatus_AfterOneUserRegisters_IsClosed(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)
	registerViaRealCeremony(t, srv)

	resp, err := testClient(t).Get(srv.URL + "/api/auth/registration-status")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Open bool `json:"open"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.False(t, body.Open)
}

// beginAndAttest starts a registration ceremony and returns the attestation
// response a virtual authenticator would send to finish it, so a test can
// decide when, and how many at once, to finish.
func beginAndAttest(tb testing.TB, srv *httptest.Server) string {
	tb.Helper()

	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	resp, err := testClient(tb).Post(srv.URL+"/api/auth/register/begin", "application/json", nil)
	require.NoError(tb, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(tb, http.StatusOK, resp.StatusCode)

	options, err := virtualwebauthn.ParseAttestationOptions(readAll(tb, resp))
	require.NoError(tb, err)

	return virtualwebauthn.CreateAttestationResponse(rp, virtualwebauthn.NewAuthenticator(), virtualwebauthn.NewCredential(virtualwebauthn.KeyTypeEC2), *options)
}

// Only the first passkey registration on an empty instance wins. Two visitors
// who both began before either finished leave one owner with one passkey: the
// second to finish gets no session, and no account is left behind.
func TestRegisterFinish_TwoCeremoniesFinishingTogether_AtMostOneWins(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	attestations := []string{beginAndAttest(t, srv), beginAndAttest(t, srv)}

	statuses := make([]int, len(attestations))
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, attestation := range attestations {
		wg.Go(func() {
			<-start
			resp, err := testClient(t).Post(srv.URL+"/api/auth/register/finish", "application/json", strings.NewReader(attestation))
			if err != nil {
				return
			}
			defer func() { _ = resp.Body.Close() }()
			statuses[i] = resp.StatusCode
		})
	}
	close(start)
	wg.Wait()

	wins := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			wins++
		}
	}
	// Both begins share one ceremony, so the stale attestation can also spoil the
	// winner by clearing it first: what must never happen is two registrations.
	assert.LessOrEqual(t, wins, 1, "statuses: %v", statuses)
}

func TestRegisterFinish_AnotherCeremonyAlreadyFinished_IsRefused(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	first := beginAndAttest(t, srv)
	resp, err := testClient(t).Post(srv.URL+"/api/auth/register/finish", "application/json", strings.NewReader(first))
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	resp, err = testClient(t).Post(srv.URL+"/api/auth/register/finish", "application/json", strings.NewReader(first))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.GreaterOrEqual(t, resp.StatusCode, http.StatusBadRequest)
}
