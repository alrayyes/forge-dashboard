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

// setupFixture is one server that can link both forges, each against a fake.
type setupFixture struct {
	gh *ghConnFixture
	fj *connFixture
}

func newSetupFixture(t *testing.T, slug string) *setupFixture {
	t.Helper()

	ghHost := newFakeGitHubHost(t)
	forge := newFakeForgejoInstance(t)
	srv, _, _, _, db, _ := newTestServerWithDatabase(t, func(settingspkg.Credentials) []dashboard.Source { return nil }, false, 0,
		func(d *api.Deps) {
			d.PublicOrigin = testOrigin
			d.GitHubAppSlug = slug
			d.GitHubOAuth = oauth.NewGitHubAt(t.Context(), "gh-id", "gh-secret", ghConnRedirect, d.SettingsStore,
				oauth.GitHubURLs{Web: ghHost.server.URL, API: ghHost.server.URL})
			d.ForgejoOAuth = oauth.NewForgejo(t.Context(), "", "", connRedirect, d.SettingsStore)
			d.ForgejoOAuth.UseClientStore(d.SettingsStore)
		})
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return &setupFixture{
		gh: &ghConnFixture{srv: srv, cookie: cookie, gh: ghHost, db: db},
		fj: &connFixture{srv: srv, cookie: cookie, forge: forge, db: db},
	}
}

func (f *setupFixture) read(t *testing.T) map[string]any {
	t.Helper()

	resp := doJSON(t, http.MethodGet, f.gh.srv.URL+"/api/v1/setup", "", f.gh.cookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body map[string]any
	require.NoError(t, readJSON(resp, &body))

	return body
}

// linkForgejo walks the sign-in with a Client ID the owner names.
func (f *setupFixture) linkForgejo(t *testing.T) {
	t.Helper()

	status, body := f.fj.startPublic(t, "owners-client")
	require.Equal(t, http.StatusOK, status, "%v", body)

	u, err := url.Parse(body["authorizeUrl"].(string))
	require.NoError(t, err)
	f.fj.forge.mu.Lock()
	f.fj.forge.challenge = u.Query().Get("code_challenge")
	f.fj.forge.mu.Unlock()

	resp := f.fj.callback(t, "code=good-code&state="+url.QueryEscape(u.Query().Get("state")))
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusSeeOther, resp.StatusCode)
}

func section(t *testing.T, body map[string]any, key string) map[string]any {
	t.Helper()

	s, ok := body[key].(map[string]any)
	require.True(t, ok, "%s is missing from %v", key, body)

	return s
}

func TestSetupGet_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp := doJSON(t, http.MethodGet, srv.URL+"/api/v1/setup", "", nil)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestSetupGet_BeforeAnythingIsLinked(t *testing.T) {
	t.Parallel()

	body := newSetupFixture(t, "forge-board").read(t)
	gh, fj := section(t, body, "github"), section(t, body, "forgejo")

	t.Run("github is configured", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, true, gh["configured"])
	})

	t.Run("github is not authorized", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, false, gh["authorized"])
	})

	t.Run("github names where to install the app", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "https://github.com/apps/forge-board/installations/new", gh["installUrl"])
	})

	t.Run("github lists no installations", func(t *testing.T) {
		t.Parallel()
		assert.Empty(t, gh["installations"])
	})

	t.Run("forgejo gives the redirect uri to register", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, connRedirect, fj["redirectUri"])
	})

	t.Run("forgejo gives the scopes the sign-in asks for", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, []any{"write:repository", "write:issue", "read:user"}, fj["scopes"])
	})

	t.Run("forgejo is not linked", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, false, fj["linked"])
	})

	t.Run("nothing has refreshed yet", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, false, body["refreshed"])
	})
}

func TestSetupGet_WithoutASlug_HasNoInstallURL(t *testing.T) {
	t.Parallel()

	gh := section(t, newSetupFixture(t, "").read(t), "github")

	assert.Empty(t, gh["installUrl"])
}

func TestSetupGet_AfterGitHubAuthorizes_ListsTheAccountsInstallations(t *testing.T) {
	t.Parallel()

	f := newSetupFixture(t, "forge-board")
	f.gh.connect(t)
	saved := f.gh.installed(t, "installation_id=200&setup_action=install")
	_ = saved.Body.Close()

	gh := section(t, f.read(t), "github")

	t.Run("authorized as the account", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "octocat", gh["account"])
	})

	t.Run("every installation GitHub lists", func(t *testing.T) {
		t.Parallel()
		assert.Len(t, gh["installations"], 2)
	})

	t.Run("only the stored one is saved", func(t *testing.T) {
		t.Parallel()

		var savedIDs []float64
		for _, raw := range gh["installations"].([]any) {
			in := raw.(map[string]any)
			if in["saved"] == true {
				savedIDs = append(savedIDs, in["id"].(float64))
			}
		}
		assert.Equal(t, []float64{200}, savedIDs)
	})
}

func TestSetupGet_AfterForgejoLinks_NamesTheInstanceAndAccount(t *testing.T) {
	t.Parallel()

	f := newSetupFixture(t, "forge-board")
	f.linkForgejo(t)

	fj := section(t, f.read(t), "forgejo")

	t.Run("linked", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, true, fj["linked"])
	})

	t.Run("the account", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, "alice", fj["account"])
	})

	t.Run("the instance", func(t *testing.T) {
		t.Parallel()
		assert.Equal(t, f.fj.forge.server.URL, fj["instanceUrl"])
	})
}
