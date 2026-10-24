package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"testing"

	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// getSettingsSummary reads GET /api/settings/summary and answers the status,
// the raw body and the decoded body.
func getSettingsSummary(t *testing.T, srvURL string, cookie *http.Cookie) (int, string, map[string]any) {
	t.Helper()

	resp := doJSON(t, http.MethodGet, srvURL+"/api/settings/summary", "", cookie)
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	var decoded map[string]any
	if resp.StatusCode == http.StatusOK {
		require.NoError(t, json.Unmarshal(raw, &decoded))
	}

	return resp.StatusCode, string(raw), decoded
}

func TestSettingsSummary_ReadCreatesNoWebhookCredentials(t *testing.T) {
	t.Parallel()

	srv, _, _, store := newTestServerWithSettingsStore(t, noSources, false, 0)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	for range 2 {
		status, _, body := getSettingsSummary(t, srv.URL, cookie)
		require.Equal(t, http.StatusOK, status)
		assert.Equal(t, false, body["webhookConfigured"])
	}

	creds, err := store.Get(t.Context())
	if err != nil {
		require.ErrorIs(t, err, settingspkg.ErrNotFound)
	}
	assert.Empty(t, creds.WebhookToken, "the summary read must not create a webhook token")
	assert.Empty(t, creds.WebhookSecret, "the summary read must not create a webhook secret")

	getSettings(t, srv.URL, cookie) // the Settings page read provisions them
	_, _, body := getSettingsSummary(t, srv.URL, cookie)
	assert.Equal(t, true, body["webhookConfigured"])
}

func TestSettingsSummary_NeverCarriesAnySecret(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)
	creds := getSettings(t, srv.URL, cookie)
	require.NotEmpty(t, creds.WebhookToken)
	require.NotEmpty(t, creds.WebhookSecret)

	status, raw, body := getSettingsSummary(t, srv.URL, cookie)

	require.Equal(t, http.StatusOK, status)
	for _, secret := range []string{"ghp_secret_value", "fj_secret_value", creds.WebhookToken, creds.WebhookSecret} {
		assert.NotContains(t, raw, secret)
	}
	assert.NotContains(t, body, "webhookToken")
	assert.NotContains(t, body, "webhookSecret")
	assert.Equal(t, true, body["webhookConfigured"])
	assert.Equal(t, true, body["githubTokenSet"])
}

func TestSettingsSummary_EqualsTheMCPGetSettingsOutput(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)

	for _, provisioned := range []bool{false, true} {
		if provisioned {
			getSettings(t, srv.URL, cookie)
		}
		status, _, body := getSettingsSummary(t, srv.URL, cookie)
		require.Equal(t, http.StatusOK, status)

		assert.Equal(t, settingsContent(t, callSettingsTool(t, srv.URL, cookie)), body)
	}
}

func TestSettingsSummary_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)

	status, _, _ := getSettingsSummary(t, srv.URL, nil)

	assert.Equal(t, http.StatusUnauthorized, status)
}

func TestContract_SettingsSummary(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	status, _ := putSettings(t, srv.URL, seededSettings, cookie)
	require.Equal(t, http.StatusOK, status)

	req, got := record(t, http.MethodGet, srv.URL+"/api/settings/summary", cookie)

	require.Equal(t, http.StatusOK, got.status)
	validateAgainstSpec(t, req, got)
}
