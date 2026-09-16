package api_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
	_ "modernc.org/sqlite"
)

func hexHMAC(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// countingSource increments a shared counter on every Fetch — used to
// tell "the dashboard reflects the state Ensure started it with" apart
// from "a webhook delivery made it fetch again", which a static
// fakeConfiguredSource can't distinguish.
type countingSource struct {
	calls *atomic.Int64
}

func (s *countingSource) Fetch(_ context.Context) dashboard.Result {
	n := s.calls.Add(1)
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: int(n)}}
}

func (s *countingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

// slowCountingSource only advances calls if its Fetch runs to completion —
// a context canceled mid-fetch (the real forge clients' own http.Client
// requests abort the same way) leaves it untouched. That's what makes it
// able to tell "the refresh survived the request that triggered it ending"
// apart from "it didn't."
type slowCountingSource struct {
	calls *atomic.Int64
	delay time.Duration
}

func (s *slowCountingSource) Fetch(ctx context.Context) dashboard.Result {
	select {
	case <-time.After(s.delay):
		n := s.calls.Add(1)
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: int(n)}}
	case <-ctx.Done():
		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, Error: ctx.Err().Error()}}
	}
}

func (s *slowCountingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

// repoCountingSource implements dashboard.RepoRefresher as well as
// dashboard.Source, tracking full-account Fetch calls separately from
// per-repo FetchRepo calls — the assertion surface for "a webhook naming
// a repo triggered a scoped refresh, not a full one."
type repoCountingSource struct {
	fetchCalls     *atomic.Int64
	repoFetchCalls sync.Map // fullName string -> *atomic.Int64
}

func (s *repoCountingSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *repoCountingSource) Fetch(_ context.Context) dashboard.Result {
	n := s.fetchCalls.Add(1)
	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: int(n)},
		Repos:  []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/tempus-fugit"}},
	}
}

func (s *repoCountingSource) FetchRepo(_ context.Context, _, _, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	counter, _ := s.repoFetchCalls.LoadOrStore(fullName, &atomic.Int64{})
	counter.(*atomic.Int64).Add(1)
	return []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: fullName, Number: 1}}, nil, nil
}

func (s *repoCountingSource) repoFetchCallCount(fullName string) int64 {
	counter, ok := s.repoFetchCalls.Load(fullName)
	if !ok {
		return 0
	}
	return counter.(*atomic.Int64).Load()
}

// newTestServerWithCountingSource registers a user, saves a throwaway
// GitHub token so a countingSource is wired into their Manager
// Aggregator (RefreshNow is a no-op against a user nothing ever called
// Ensure for), and returns the server URL, the shared fetch counter a
// successful webhook delivery should advance, and the session cookie.
func newTestServerWithCountingSource(t *testing.T) (srv string, calls *atomic.Int64, sessionCookie *http.Cookie) {
	t.Helper()
	calls = &atomic.Int64{}
	srv, sessionCookie = newTestServerWithSource(t, &countingSource{calls: calls})
	require.Eventually(t, func() bool { return calls.Load() >= 1 }, time.Second, 5*time.Millisecond, "Ensure should have fetched at least once already")
	return srv, calls, sessionCookie
}

// newTestServerWithSource is newTestServerWithCountingSource's shared
// core, parametrized on the Source so a slow one (below) can drive the
// same setup.
//
// Deliberately builds its own server rather than using the shared
// newTestServerWithSources helper: that one's Manager ticks every
// testRefreshInterval (10ms), which would tick during a test's own
// assertion window and make "a webhook delivery caused a fetch" and "the
// background timer happened to fire" indistinguishable. An interval far
// longer than any single test can run means the only fetches during it
// are Ensure's own initial one and whatever RefreshNow calls happen.
func newTestServerWithSource(t *testing.T, source dashboard.Source) (srv string, sessionCookie *http.Cookie) {
	t.Helper()
	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken == "" {
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
	})
	testSrv := httptest.NewServer(mux)
	t.Cleanup(testSrv.Close)

	sessionCookie, _, _ = registerViaRealCeremony(t, testSrv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, testSrv.URL+"/api/settings", strings.NewReader(`{"githubToken":"placeholder-token"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	return testSrv.URL, sessionCookie
}

func webhookCredentials(t *testing.T, srvURL string, sessionCookie *http.Cookie) (token, secret string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/settings", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var got api.SettingsResponse
	require.NoError(t, readJSON(resp, &got))
	require.NotEmpty(t, got.WebhookToken)
	require.NotEmpty(t, got.WebhookSecret)
	return got.WebhookToken, got.WebhookSecret
}

func TestGitHubWebhook_ValidSignature_TriggersRefreshAndReturns204(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond, "a verified webhook delivery should trigger an immediate refresh")
}

// dashboardRepoStatus mirrors the API's per-repo shape on
// GET /api/dashboard's own "repos" field — a local copy rather than an
// import from internal/api, since that field lives on a response DTO the
// api package builds, not on dashboard.Snapshot itself.
type dashboardRepoStatus struct {
	Forge      string `json:"forge"`
	FullName   string `json:"fullName"`
	HasWebhook bool   `json:"hasWebhook"`
}

func dashboardRepos(t *testing.T, srvURL string, sessionCookie *http.Cookie) []dashboardRepoStatus {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	var body struct {
		Repos []dashboardRepoStatus `json:"repos"`
	}
	require.NoError(t, readJSON(resp, &body))
	return body.Repos
}

func TestGitHubWebhook_VerifiedDelivery_MarksRepoAsHavingAWebhookOnTheDashboard(t *testing.T) {
	t.Parallel()

	source := &repoCountingSource{fetchCalls: &atomic.Int64{}}
	srvURL, sessionCookie := newTestServerWithSource(t, source)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	require.Eventually(t, func() bool {
		repos := dashboardRepos(t, srvURL, sessionCookie)
		return assert.ObjectsAreEqual([]dashboardRepoStatus{{Forge: "github", FullName: "alrayyes/tempus-fugit", HasWebhook: false}}, repos)
	}, time.Second, 10*time.Millisecond, "the tracked repo should start out without a confirmed webhook")

	body := []byte(`{"action":"opened","repository":{"full_name":"alrayyes/tempus-fugit","name":"tempus-fugit","owner":{"login":"alrayyes"}}}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	require.Eventually(t, func() bool {
		repos := dashboardRepos(t, srvURL, sessionCookie)
		return assert.ObjectsAreEqual([]dashboardRepoStatus{{Forge: "github", FullName: "alrayyes/tempus-fugit", HasWebhook: true}}, repos)
	}, time.Second, 10*time.Millisecond, "a verified delivery for the repo should flip it to having a confirmed webhook")
}

// staticHasWebhookSource reports one repo with HasWebhook already true
// straight from Fetch — the shape a live forge-API check (#238) reports,
// as opposed to repoCountingSource's zero-value false that only flips
// once settings.Store records a real delivery. Used to prove
// buildDashboardResponse treats the two signals as an OR, not "delivery
// table only."
type staticHasWebhookSource struct{}

func (s *staticHasWebhookSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *staticHasWebhookSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		Repos:  []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/tempus-fugit", HasWebhook: true}},
	}
}

func TestDashboard_LiveDetectedWebhook_ReportsHasWebhookTrueWithNoDeliveryRecorded(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithSource(t, &staticHasWebhookSource{})

	require.Eventually(t, func() bool {
		repos := dashboardRepos(t, srvURL, sessionCookie)
		return assert.ObjectsAreEqual([]dashboardRepoStatus{{Forge: "github", FullName: "alrayyes/tempus-fugit", HasWebhook: true}}, repos)
	}, time.Second, 10*time.Millisecond, "a live-detected webhook should report as confirmed even with zero deliveries ever recorded")
}

func TestGitHubWebhook_MissingSignature_Refused(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	resp, err := http.Post(srvURL+"/api/webhooks/github/"+token, "application/json", strings.NewReader(`{"action":"opened"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, before, calls.Load(), "an unverified delivery must never trigger a refresh")
}

func TestGitHubWebhook_WrongSecret_Refused(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, "not-the-real-secret"))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, before, calls.Load())
}

func TestGitHubWebhook_TamperedBody_Refused(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)

	signedBody := []byte(`{"action":"opened"}`)
	sentBody := []byte(`{"action":"closed"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(sentBody)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(signedBody, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGitHubWebhook_UnknownToken_Returns404(t *testing.T) {
	t.Parallel()

	srvURL, _, _ := newTestServerWithCountingSource(t)

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/not-a-real-token", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, "whatever"))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestForgejoWebhook_ValidForgejoSignatureHeader_TriggersRefresh(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/forgejo/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Forgejo-Signature", hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond)
}

func TestForgejoWebhook_ValidGiteaSignatureHeaderFallback_TriggersRefresh(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/forgejo/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	// No X-Forgejo-Signature here — an instance whose webhook was set up
	// with the legacy "Gitea" type only ever sends this one.
	req.Header.Set("X-Gitea-Signature", hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond)
}

func TestForgejoWebhook_MissingSignature_Refused(t *testing.T) {
	t.Parallel()

	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	resp, err := http.Post(srvURL+"/api/webhooks/forgejo/"+token, "application/json", strings.NewReader(`{"action":"opened"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, before, calls.Load())
}

func TestForgejoWebhook_WrongSecret_Refused(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/forgejo/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Forgejo-Signature", hexHMAC(body, "not-the-real-secret"))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestForgejoWebhook_UnknownToken_Returns404(t *testing.T) {
	t.Parallel()

	srvURL, _, _ := newTestServerWithCountingSource(t)

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/forgejo/not-a-real-token", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Forgejo-Signature", hexHMAC(body, "whatever"))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestGitHubWebhook_PayloadNamesARepo_TriggersOnlyAScopedRefresh(t *testing.T) {
	t.Parallel()

	// Real incident: a webhook for one repository in a many-repo account
	// triggered a full account-wide refresh, repeatedly enough to exhaust
	// the account's shared GitHub rate-limit budget. The payload already
	// names the repo that changed; a scoped refresh should use it instead
	// of re-fetching every tracked repo.
	source := &repoCountingSource{fetchCalls: &atomic.Int64{}}
	srvURL, sessionCookie := newTestServerWithSource(t, source)
	require.Eventually(t, func() bool { return source.fetchCalls.Load() >= 1 }, time.Second, 5*time.Millisecond, "Ensure should have fetched at least once already")
	fetchesBeforeWebhook := source.fetchCalls.Load()

	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	body := []byte(`{"action":"opened","repository":{"full_name":"alrayyes/tempus-fugit","name":"tempus-fugit","owner":{"login":"alrayyes"}}}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Eventually(t, func() bool { return source.repoFetchCallCount("alrayyes/tempus-fugit") >= 1 }, time.Second, 10*time.Millisecond,
		"a webhook naming a repo should trigger a scoped refresh for it")
	assert.Equal(t, fetchesBeforeWebhook, source.fetchCalls.Load(), "a scoped refresh must not also trigger a full account-wide fetch")
}

func TestGitHubWebhook_PayloadWithNoRepository_FallsBackToFullRefresh(t *testing.T) {
	t.Parallel()

	// The "ping" event Forgejo/GitHub send when a webhook is first created,
	// and any payload shape this handler doesn't recognize, should still
	// result in a refresh — just the account-wide one, not silently
	// nothing.
	srvURL, calls, sessionCookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"zen":"Responsive is better than fast."}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond,
		"a payload with no repository field should still fall back to a full refresh")
}

func TestWebhook_RefreshSurvivesTheTriggeringRequestEnding(t *testing.T) {
	t.Parallel()

	// Real incident: a webhook delivery to an account with many tracked
	// repos took long enough that the sender (Forgejo) gave up waiting
	// and closed the connection mid-refresh — tying the refresh to the
	// request's own context meant that canceled every in-flight forge
	// fetch, so the webhook accomplished nothing.
	calls := &atomic.Int64{}
	source := &slowCountingSource{calls: calls, delay: 150 * time.Millisecond}
	srvURL, sessionCookie := newTestServerWithSource(t, source)
	require.Eventually(t, func() bool { return calls.Load() >= 1 }, time.Second, 5*time.Millisecond, "Ensure should have fetched at least once already")

	token, secret := webhookCredentials(t, srvURL, sessionCookie)
	before := calls.Load()

	body := []byte(`{"action":"opened"}`)
	reqCtx, cancelReq := context.WithCancel(t.Context())
	defer cancelReq()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, secret))

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Less(t, time.Since(start), source.delay, "the delivery should be acknowledged before the refresh it triggers finishes")

	// The sender hangs up right after getting its response — real Forgejo
	// deliveries don't wait around either. This should have no effect on
	// the refresh already running in the background.
	cancelReq()

	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond, "the refresh should complete even after the request that triggered it ends")
}

// TestGitHubWebhook_InvalidSignature_LogsForgeEventAndDeliveryID is a
// regression test for a real incident: webhooks were enabled and firing,
// but there was no way to tell from the process's own logs whether a
// delivery even arrived, let alone why it didn't visibly refresh anything
// — the same "can't diagnose from the outside" gap LOG_LEVEL's own
// request logging exists to close for outbound calls. Deliberately not
// t.Parallel(): it swaps the global slog default, which only stays safe
// while every other test in the package is still blocked at its own
// t.Parallel() call rather than actually running (Go's testing package
// runs every non-parallel test to completion before any parallel one's
// body proceeds past that call), so no other test's own logging can land
// in the captured buffer.
func TestGitHubWebhook_InvalidSignature_LogsForgeEventAndDeliveryID(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)
	token, _ := webhookCredentials(t, srvURL, sessionCookie)

	body := []byte(`{"action":"opened"}`)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+token, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.Header.Set("X-Hub-Signature-256", "sha256=not-the-real-signature")
	req.Header.Set("X-GitHub-Delivery", "test-delivery-id-123")
	req.Header.Set("X-GitHub-Event", "issues")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	logged := logs.String()
	assert.Contains(t, logged, "webhook signature invalid")
	assert.Contains(t, logged, "forge=github")
	assert.Contains(t, logged, "event=issues")
	assert.Contains(t, logged, "delivery=test-delivery-id-123")
}
