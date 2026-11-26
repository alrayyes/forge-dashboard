package api_test

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// installationHook is a signed GitHub App delivery against the test server.
type installationHook struct {
	srv    string
	token  string
	secret string
	store  *settingspkg.Store
	calls  *atomic.Int64
}

func newInstallationHook(t *testing.T) *installationHook {
	t.Helper()

	srv, calls, cookie := newTestServerWithCountingSource(t)
	token, secret := webhookCredentials(t, srv, cookie)
	store, ok := testSettingsStores.Load(srv)
	require.True(t, ok)

	return &installationHook{srv: srv, token: token, secret: secret, store: store.(*settingspkg.Store), calls: calls}
}

func (h *installationHook) deliver(t *testing.T, event, body string) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, h.srv+"/api/webhooks/github/"+h.token, strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC([]byte(body), h.secret))
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func (h *installationHook) installations(t *testing.T) []settingspkg.Installation {
	t.Helper()

	got, err := h.store.Installations(t.Context())
	require.NoError(t, err)

	return got
}

func TestInstallationWebhook_Created_AddsTheRowWithItsAccount(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t)
	before := h.calls.Load()

	h.deliver(t, "installation", `{"action":"created","installation":{"id":501,"account":{"login":"acme-org"}}}`)

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, int64(501), got[0].ID)
	assert.Equal(t, "acme-org", got[0].AccountLogin)
	assert.True(t, got[0].Enabled)
	require.Eventually(t, func() bool { return h.calls.Load() > before }, time.Second, 10*time.Millisecond,
		"the dashboard should be rebuilt so reads use the new installation")
}

func TestInstallationWebhook_Deleted_RemovesTheRow(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 502, AccountLogin: "other"}))

	h.deliver(t, "installation", `{"action":"deleted","installation":{"id":501,"account":{"login":"acme-org"}}}`)

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, int64(502), got[0].ID)
}

func TestInstallationWebhook_SuspendThenUnsuspend_MarksAndLiftsTheRow(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))

	h.deliver(t, "installation", `{"action":"suspend","installation":{"id":501,"account":{"login":"acme-org"}}}`)

	got := h.installations(t)
	require.Len(t, got, 1)
	assert.Equal(t, settingspkg.InstallationSuspended, got[0].Status)
	assert.False(t, got[0].Enabled)

	h.deliver(t, "installation", `{"action":"unsuspend","installation":{"id":501,"account":{"login":"acme-org"}}}`)

	got = h.installations(t)
	assert.Equal(t, settingspkg.InstallationConnected, got[0].Status)
	assert.True(t, got[0].Enabled)
}

func TestInstallationWebhook_UnsignedDelivery_ChangesNothing(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t)
	body := `{"action":"created","installation":{"id":501,"account":{"login":"acme-org"}}}`
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

func TestInstallationRepositoriesWebhook_KnownInstallation_ReReadsTheRepositories(t *testing.T) {
	t.Parallel()

	h := newInstallationHook(t)
	require.NoError(t, h.store.SaveInstallation(t.Context(), settingspkg.Installation{ID: 501, AccountLogin: "acme-org"}))
	before := h.calls.Load()

	h.deliver(t, "installation_repositories",
		`{"action":"added","installation":{"id":501,"account":{"login":"acme-org"}},"repositories_added":[{"full_name":"acme-org/tool"}]}`)

	require.Eventually(t, func() bool { return h.calls.Load() > before }, time.Second, 10*time.Millisecond,
		"a repository change should make the dashboard read the installation's repositories again")
}
