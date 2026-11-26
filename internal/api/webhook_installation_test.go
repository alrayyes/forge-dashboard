package api_test

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// installationHook is a signed GitHub App delivery against a test server whose
// GitHub fake lists installations 100 and 200 for the linked account.
type installationHook struct {
	srv    string
	token  string
	secret string
	store  *settingspkg.Store
	db     *sql.DB
	calls  *atomic.Int64
	conn   *ghConnFixture

	mu     sync.Mutex
	builds [][]int64
}

func newInstallationHook(t *testing.T, connected bool) *installationHook {
	t.Helper()

	h := &installationHook{calls: &atomic.Int64{}}
	gh := newFakeGitHubHost(t)
	build := func(c settingspkg.Credentials) []dashboard.Source {
		h.mu.Lock()
		h.builds = append(h.builds, c.GitHubAppInstallationIDs)
		h.mu.Unlock()
		if len(c.GitHubAppInstallationIDs) == 0 {
			return nil
		}

		return []dashboard.Source{&countingSource{calls: h.calls}}
	}
	srv, service, _, store, db, _ := newTestServerWithDatabase(t, build, false, 0, func(d *api.Deps) {
		d.GitHubOAuth = oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghConnRedirect, d.SettingsStore,
			oauth.GitHubURLs{Web: gh.server.URL, API: gh.server.URL})
	})
	cookie, _, _ := registerViaRealCeremony(t, srv)
	h.conn = &ghConnFixture{srv: srv, cookie: cookie, gh: gh, db: db}
	if connected {
		h.conn.connect(t)
	}
	service.Ensure(t.Context(), []dashboard.Source{&countingSource{calls: h.calls}})
	h.token, h.secret = webhookCredentials(t, srv.URL, cookie)
	h.srv, h.store, h.db = srv.URL, store, db
	h.mu.Lock()
	h.builds = nil
	h.mu.Unlock()

	return h
}

func (h *installationHook) post(t *testing.T, event, body string) int {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, h.srv+"/api/webhooks/github/"+h.token, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC([]byte(body), h.secret))
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()

	return resp.StatusCode
}

func (h *installationHook) deliver(t *testing.T, event, body string) {
	t.Helper()

	require.Equal(t, http.StatusNoContent, h.post(t, event, body))
}

func (h *installationHook) installations(t *testing.T) []settingspkg.Installation {
	t.Helper()

	got, err := h.store.Installations(t.Context())
	require.NoError(t, err)

	return got
}

func (h *installationHook) lastBuild(t *testing.T) ([]int64, bool) {
	t.Helper()

	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.builds) == 0 {
		return nil, false
	}

	return h.builds[len(h.builds)-1], true
}

func hookBody(action string, id int64, login string) string {
	return `{"action":"` + action + `","installation":{"id":` + strconv.FormatInt(id, 10) + `,"account":{"login":"` + login + `"}}}`
}

func TestInstallationWebhook_Created_ForAnInstallationTheLinkedAccountCanSee_AddsTheRow(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)

	h.deliver(t, "installation", hookBody("created", 200, "ignored-payload-login"))

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, int64(200), got[0].ID)
	assert.Equal(t, "acme-org", got[0].AccountLogin, "the account comes from GitHub's own list, not the payload")
	assert.True(t, got[0].Enabled)
	ids, built := h.lastBuild(t)
	assert.True(t, built, "the sources should be rebuilt")
	assert.Equal(t, []int64{200}, ids)
}

func TestInstallationWebhook_Created_ForAnInstallationTheLinkedAccountCannotSee_StoresNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)

	h.deliver(t, "installation", hookBody("created", 999, "stranger"))

	assert.Empty(t, h.installations(t))
	_, built := h.lastBuild(t)
	assert.False(t, built)
}

func TestInstallationWebhook_Created_WithNoLinkedAccount_StoresNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, false)

	h.deliver(t, "installation", hookBody("created", 200, "acme-org"))

	assert.Empty(t, h.installations(t))
}

func TestInstallationWebhook_Created_ForAKnownSuspendedInstallation_ChangesNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 200, AccountLogin: "acme-org"}))
	require.NoError(t, h.store.SetInstallationSuspended(t.Context(), 200, true))

	h.deliver(t, "installation", hookBody("created", 200, "acme-org"))

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, settingspkg.InstallationSuspended, got[0].Status)
	assert.False(t, got[0].Enabled)
	_, built := h.lastBuild(t)
	assert.False(t, built, "a delivery that changed nothing should not rebuild the sources")
}

func TestInstallationWebhook_Created_WhenGitHubsListFails_Is500AndStoresNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	h.conn.gh.server.Close()

	assert.Equal(t, http.StatusInternalServerError, h.post(t, "installation", hookBody("created", 200, "acme-org")))

	assert.Empty(t, h.installations(t))
}

func TestInstallationWebhook_Deleted_RemovesTheRow(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 502, AccountLogin: "other"}))

	h.deliver(t, "installation", hookBody("deleted", 501, "acme-org"))

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, int64(502), got[0].ID)
}

func TestInstallationWebhook_DeletingTheLastInstallation_ReplacesTheSourcesWithNone(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))

	h.deliver(t, "installation", hookBody("deleted", 501, "acme-org"))

	ids, built := h.lastBuild(t)
	assert.True(t, built, "the aggregator must be rebuilt, or it keeps reading the removed installation")
	assert.Empty(t, ids)
	before := h.calls.Load()
	assert.Never(t, func() bool { return h.calls.Load() > before }, 100*time.Millisecond, 10*time.Millisecond,
		"nothing should be fetching any more")
}

func TestInstallationWebhook_SuspendThenUnsuspend_MarksAndLiftsTheRow(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))

	h.deliver(t, "installation", hookBody("suspend", 501, "acme-org"))

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, settingspkg.InstallationSuspended, got[0].Status)
	assert.False(t, got[0].Enabled)

	h.deliver(t, "installation", hookBody("unsuspend", 501, "acme-org"))

	got = h.installations(t)
	assert.Equal(t, settingspkg.InstallationConnected, got[0].Status)
	assert.True(t, got[0].Enabled)
}

func TestInstallationWebhook_SuspendOrDeleteOfAnUnstoredID_ChangesNothingAndDoesNotRebuild(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)

	h.deliver(t, "installation", hookBody("suspend", 404, "nobody"))
	h.deliver(t, "installation", hookBody("deleted", 404, "nobody"))

	assert.Empty(t, h.installations(t))
	_, built := h.lastBuild(t)
	assert.False(t, built)
}

func TestInstallationWebhook_MalformedBody_Is204AndChangesNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)

	h.deliver(t, "installation", `{"action":`)

	assert.Empty(t, h.installations(t))
}

func TestInstallationWebhook_AStoreFailure_Is500SoARedeliveryCanRerun(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	_, err := h.db.ExecContext(t.Context(), `DROP TABLE github_app_installations`)
	require.NoError(t, err)

	assert.Equal(t, http.StatusInternalServerError, h.post(t, "installation", hookBody("deleted", 501, "acme-org")))
}

func TestInstallationWebhook_UnsignedDelivery_ChangesNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t, true)
	body := hookBody("created", 200, "acme-org")
	req, err := http.NewRequest(http.MethodPost, h.srv+"/api/webhooks/github/"+h.token, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("X-GitHub-Event", "installation")
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC([]byte(body), "wrong-secret"))
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
	assert.Empty(t, h.installations(t))
}

// repositoriesHook is a server whose board only refreshes when a delivery says
// so, unlike newInstallationHook's, which ticks every few milliseconds.
func repositoriesHook(t *testing.T) (*installationHook, *atomic.Int64) {
	t.Helper()

	srv, calls, cookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srv, cookie)
	store, ok := testSettingsStores.Load(srv)
	require.True(t, ok)

	return &installationHook{srv: srv, token: token, secret: secret, store: store.(*settingspkg.Store)}, calls
}

func TestInstallationRepositoriesWebhook_KnownInstallation_RefreshesTheBoard(t *testing.T) {
	t.Parallel()

	h, calls := repositoriesHook(t)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))
	before := calls.Load()

	h.deliver(t, "installation_repositories", hookBody("added", 501, "acme-org"))

	require.Eventually(t, func() bool { return calls.Load() > before }, time.Second, 10*time.Millisecond)
}

func TestInstallationRepositoriesWebhook_UnknownInstallation_DoesNotRefresh(t *testing.T) {
	t.Parallel()

	h, calls := repositoriesHook(t)
	before := calls.Load()

	h.deliver(t, "installation_repositories", hookBody("added", 404, "nobody"))

	assert.Never(t, func() bool { return calls.Load() > before }, 100*time.Millisecond, 10*time.Millisecond)
}
