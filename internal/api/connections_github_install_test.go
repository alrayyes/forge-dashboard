package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func (c *ghConnFixture) installed(t *testing.T, query string) *http.Response {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, c.srv.URL+"/api/v1/connections/github/installed?"+query, nil)
	require.NoError(t, err)
	req.AddCookie(c.cookie)
	client := testClient(t)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := client.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	return resp
}

func (c *ghConnFixture) installationRows(t *testing.T) []int64 {
	t.Helper()

	rows, err := c.db.QueryContext(t.Context(), `SELECT installation_id FROM github_app_installations ORDER BY position`)
	require.NoError(t, err)
	defer func() { _ = rows.Close() }()

	var ids []int64
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		ids = append(ids, id)
	}
	require.NoError(t, rows.Err())

	return ids
}

func TestGitHubInstalled_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/connections/github/installed?installation_id=100&setup_action=install", "", nil)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestGitHubInstalled_AnIDInTheUsersInstallations_IsStoredWithItsAccountAndRedirects(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)

	resp := c.installed(t, "installation_id=200&setup_action=install")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusSeeOther, resp.StatusCode)
	assert.Equal(t, "/settings", resp.Header.Get("Location"))
	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
	assert.Equal(t, []int64{200}, c.installationRows(t))

	var login string
	require.NoError(t, c.db.QueryRowContext(t.Context(), `SELECT account_login FROM github_app_installations`).Scan(&login))
	assert.Equal(t, "acme-org", login)
}

func TestGitHubInstalled_AnUpdateOfAKnownInstallation_KeepsOneRow(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)
	first := c.installed(t, "installation_id=100&setup_action=install")
	_ = first.Body.Close()

	resp := c.installed(t, "installation_id=100&setup_action=update")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusSeeOther, resp.StatusCode)
	assert.Equal(t, []int64{100}, c.installationRows(t))
}

func TestGitHubInstalled_AnIDNotInTheUsersInstallations_StoresNothing(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)
	c.connect(t)

	resp := c.installed(t, "installation_id=999&setup_action=install")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.Empty(t, c.installationRows(t))
}

func TestGitHubInstalled_BadInput_StoresNothing(t *testing.T) {
	t.Parallel()

	for name, query := range map[string]string{
		"no id":         "setup_action=install",
		"a text id":     "installation_id=abc&setup_action=install",
		"a negative id": "installation_id=-1&setup_action=install",
		"a zero id":     "installation_id=0&setup_action=install",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			c := newGHConnFixture(t, true)
			c.connect(t)

			resp := c.installed(t, query)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
			assert.Empty(t, c.installationRows(t))
		})
	}
}

func TestGitHubInstalled_WithoutAConnectedAccount_StoresNothing(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, true)

	resp := c.installed(t, "installation_id=100&setup_action=install")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	assert.Empty(t, c.installationRows(t))
}

func TestGitHubInstalled_WithoutAnOAuthClient_Is400(t *testing.T) {
	t.Parallel()

	c := newGHConnFixture(t, false)

	resp := c.installed(t, "installation_id=100&setup_action=install")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Empty(t, c.installationRows(t))
}
