package api_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
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
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeWebhookManagerSource implements both dashboard.Source and
// dashboard.WebhookManager directly — the shape github.Client has;
// GenericSource's own delegation to a ForgeClient is already covered by
// internal/dashboard's own tests, so this is enough to exercise the
// handler without a second copy of that coverage.
type fakeWebhookManagerSource struct {
	forge      dashboard.Forge
	ensureErr  error
	lastOwner  string
	lastName   string
	lastURL    string
	lastSecret string
}

func (f *fakeWebhookManagerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeWebhookManagerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeWebhookManagerSource) EnsureWebhook(_ context.Context, owner, name, targetURL, secret string) error {
	f.lastOwner, f.lastName, f.lastURL, f.lastSecret = owner, name, targetURL, secret

	return f.ensureErr
}

// fakeSourceWithoutWebhookSupport implements dashboard.Source only —
// the shape a forge with no webhook management at all would have.
type fakeSourceWithoutWebhookSupport struct{ forge dashboard.Forge }

func (f *fakeSourceWithoutWebhookSupport) Forge() dashboard.Forge { return f.forge }

func (f *fakeSourceWithoutWebhookSupport) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

const testPublicOrigin = "https://dashboard.example"

// newTestServerForWebhookEnsure registers a user, saves credentials for
// forge (so BuildSources actually returns source), and returns the
// server URL and session cookie — PublicOrigin fixed at
// testPublicOrigin so a test can assert the exact URL EnsureWebhook was
// called with.
func newTestServerForWebhookEnsure(t *testing.T, forge dashboard.Forge, source dashboard.Source) (srv string, sessionCookie *http.Cookie) {
	t.Helper()
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if forge == dashboard.ForgeGitHub && c.GitHubToken == "" {
			return nil
		}
		if forge == dashboard.ForgeForgejo && c.ForgejoToken == "" {
			return nil
		}

		return []dashboard.Source{source}
	}

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

	manager := dashboard.NewManager(time.Hour)
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
		PublicOrigin:  testPublicOrigin,
	})
	testSrv := httptest.NewServer(mux)
	t.Cleanup(testSrv.Close)

	sessionCookie, _, _ = registerViaRealCeremony(t, testSrv, testUser, testDisplay)

	body := `{"githubToken":"placeholder-token","forgejoUrl":"https://git.example","forgejoToken":"placeholder-token"}`
	putReq, err := http.NewRequest(http.MethodPut, testSrv.URL+"/api/settings", strings.NewReader(body))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	return testSrv.URL, sessionCookie
}

func postEnsureWebhook(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{"forge": forge, "fullName": fullName})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/ensure", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestWebhookEnsure_CallsEnsureWebhookWithTheAccountsOwnURLAndSecret(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, testPublicOrigin+"/api/webhooks/github/"+token, source.lastURL)
	assert.Equal(t, secret, source.lastSecret)
}

func TestWebhookEnsure_ForgejoDispatchesToTheForgejoSource(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, testPublicOrigin+"/api/webhooks/forgejo/"+token, source.lastURL)
}

func TestWebhookEnsure_ClientErrorPropagatesAsASpecificMessage(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{
		forge: dashboard.ForgeGitHub,
		ensureErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	var body map[string]string
	require.NoError(t, readJSON(resp, &body))
	assert.Contains(t, body["error"], assert.AnError.Error())
}

// TestWebhookEnsure_EnsureWebhookFails_LogsTheError is a regression test
// for the same "can't diagnose from the outside" gap
// TestGitHubWebhook_InvalidSignature_LogsForgeEventAndDeliveryID
// (webhooks_test.go) closed for inbound deliveries: EnsureWebhook's own
// error only reached the HTTP response, so a failed webhook creation —
// like the real "Requires authentication" GitHub returned for a REST
// call missing its Authorization header — left nothing in the process's
// own logs to diagnose it from. Deliberately not t.Parallel(), for the
// same reason that test isn't: it swaps the global slog default.
func TestWebhookEnsure_EnsureWebhookFails_LogsTheError(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	source := &fakeWebhookManagerSource{
		forge:     dashboard.ForgeGitHub,
		ensureErr: errors.New("github: GET /repos/alrayyes/a/hooks: Requires authentication"),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/a")
	defer func() { _ = resp.Body.Close() }()

	logged := logs.String()
	assert.Contains(t, logged, "webhook ensure failed")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "repo=alrayyes/a")
	assert.Contains(t, logged, "Requires authentication")
}

func TestWebhookEnsure_ForgeWithNoWebhookSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutWebhookSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_NoCredentialsSavedForThatForge_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postEnsureWebhook(t, srvURL, sessionCookie, "github", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestWebhookEnsure_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeWebhookManagerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]string{"forge": "github", "fullName": "alrayyes/a"})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/webhooks/ensure", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
