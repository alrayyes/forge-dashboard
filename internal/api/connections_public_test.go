package api_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/oauth"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// newPublicConnFixture is a server with no Forgejo client of its own: the
// owner names one on the setup page.
func newPublicConnFixture(t *testing.T) *connFixture {
	t.Helper()

	srv, _, _, _, db, _ := newTestServerWithDatabase(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0,
		func(d *api.Deps) {
			d.ForgejoOAuth = oauth.NewForgejo(t.Context(), "", "", connRedirect, d.SettingsStore)
			d.ForgejoOAuth.UseClientStore(d.SettingsStore)
		})
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return &connFixture{srv: srv, cookie: cookie, forge: newFakeForgejoInstance(t), db: db}
}

func (c *connFixture) startPublic(t *testing.T, clientID string) (int, map[string]any) {
	t.Helper()

	body := `{"instanceUrl":"` + c.forge.server.URL + `","clientId":"` + clientID + `"}`
	resp := doJSON(t, http.MethodPost, c.srv.URL+"/api/v1/connections/forgejo", body, c.cookie)
	defer func() { _ = resp.Body.Close() }()

	var out map[string]any
	require.NoError(t, readJSON(resp, &out))

	return resp.StatusCode, out
}

func (c *connFixture) storedClientIDs(t *testing.T) int {
	t.Helper()

	var n int
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT COUNT(*) FROM oauth_clients`).Scan(&n))

	return n
}

func TestConnectionsStart_WithAClientID_NeedsNoServerClient(t *testing.T) {
	t.Parallel()

	c := newPublicConnFixture(t)
	status, body := c.startPublic(t, "owners-client")
	require.Equal(t, http.StatusOK, status, "%v", body)

	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)

	t.Run("names the owner's client", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "owners-client", u.Query().Get("client_id"))
	})

	t.Run("asks for explicit scopes", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "write:repository write:issue read:user", u.Query().Get("scope"))
	})
}

func TestConnectionsStart_WithoutAnyClient_Is400NamingTheField(t *testing.T) {
	t.Parallel()

	c := newPublicConnFixture(t)
	status, body := c.start(t, c.forge.server.URL)

	assert.Equal(t, http.StatusBadRequest, status)
	assert.Equal(t, "clientId", body["field"])
}

func TestConnectionsCallback_KeepsAPublicClientsIDUntilDisconnect(t *testing.T) {
	t.Parallel()

	c := newPublicConnFixture(t)
	status, body := c.startPublic(t, "owners-client")
	require.Equal(t, http.StatusOK, status)

	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)
	c.forge.mu.Lock()
	c.forge.challenge = u.Query().Get("code_challenge")
	c.forge.mu.Unlock()

	resp := c.callback(t, "code=good-code&state="+url.QueryEscape(u.Query().Get("state")))
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)

	t.Run("linked", func(t *testing.T) {
		assert.True(t, getSettings(t, c.srv.URL, c.cookie).ForgejoOAuthConnected)
	})

	t.Run("id kept", func(t *testing.T) {
		assert.Equal(t, 1, c.storedClientIDs(t))
	})

	require.Equal(t, http.StatusNoContent, c.disconnect(t))

	t.Run("id forgotten on disconnect", func(t *testing.T) {
		assert.Zero(t, c.storedClientIDs(t))
	})
}
