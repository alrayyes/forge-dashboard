package api_test

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An avatar the saved Forgejo instance doesn't serve is refused, and the
// settings payload says which host so the page can explain the initial
// (#3683). The server reports the fact; the page decides how to word it.

func refuseAvatar(t *testing.T, srv string, cookie *http.Cookie, forge, raw, kind string) {
	t.Helper()
	q := url.Values{"forge": {forge}, "url": {raw}}
	if kind != "" {
		q.Set("kind", kind)
	}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
}

func skippedServer(t *testing.T, opts ...func(*api.Deps)) (string, *http.Cookie) {
	t.Helper()
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(imagesPNG) }))
	t.Cleanup(forge.Close)

	return imagesServer(t, forge, opts...)
}

func TestSettings_SkippedAvatarHosts_IsEmptyUntilAnAvatarIsRefused(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t)

	got := getSettings(t, srv, cookie)

	assert.NotNil(t, got.ForgejoSkippedAvatarHosts)
	assert.Empty(t, got.ForgejoSkippedAvatarHosts)
}

func TestSettings_SkippedAvatarHosts_NamesTheHostOfARefusedForgejoAvatar(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t)

	refuseAvatar(t, srv, cookie, "forgejo", "http://Gravatar.example/avatar/abc?s=64", "avatar")

	assert.Equal(t, []string{"gravatar.example"}, getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts)
	_, _, summary := getSettingsSummary(t, srv, cookie)
	assert.Equal(t, []any{"gravatar.example"}, summary["forgejoSkippedAvatarHosts"])
}

func TestSettings_SkippedAvatarHosts_ListsEachHostOnceInOrder(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t)

	for _, raw := range []string{"http://b.example/1.png", "http://a.example/1.png", "http://b.example/2.png"} {
		refuseAvatar(t, srv, cookie, "forgejo", raw, "avatar")
	}

	assert.Equal(t, []string{"a.example", "b.example"}, getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts)
}

func TestSettings_SkippedAvatarHosts_IgnoresWhatIsNotAForgejoAvatar(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t)

	refuseAvatar(t, srv, cookie, "forgejo", "http://embedded.example/a.png", "")
	refuseAvatar(t, srv, cookie, "github", "https://github-avatar.example/a.png", "avatar")
	refuseAvatar(t, srv, cookie, "forgejo", "http://user:pw@userinfo.example/a.png", "avatar")

	assert.Empty(t, getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts)
}

func TestSettings_SkippedAvatarHosts_ClearsOnceNothingIsSkippedForAWhile(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t, func(d *api.Deps) { d.SkippedAvatarTTL = 3 * time.Second })

	refuseAvatar(t, srv, cookie, "forgejo", "http://gravatar.example/a.png", "avatar")
	require.NotEmpty(t, getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts)

	require.Eventually(t, func() bool {
		return len(getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts) == 0
	}, pollBudget, 10*time.Millisecond)
}

// Every way of reading the settings carries the list, the PUT response the
// Settings page reads after a save included, and they agree.
func TestSettings_SkippedAvatarHosts_EveryReadOfTheSettingsAgrees(t *testing.T) {
	t.Parallel()
	srv, cookie := skippedServer(t)
	refuseAvatar(t, srv, cookie, "forgejo", "http://gravatar.example/a.png", "avatar")
	want := []any{"gravatar.example"}

	status, saved := putSettings(t, srv, `{"forgejoUrl":"`+getSettings(t, srv, cookie).ForgejoURL+`","forgejoUsername":"someone"}`, cookie)
	require.Equal(t, http.StatusOK, status)
	_, _, summary := getSettingsSummary(t, srv, cookie)

	assert.Equal(t, want, saved["forgejoSkippedAvatarHosts"], "PUT response")
	assert.Equal(t, want, summary["forgejoSkippedAvatarHosts"], "summary")
	assert.Equal(t, want, settingsContent(t, callSettingsTool(t, srv, cookie))["forgejoSkippedAvatarHosts"], "MCP get_settings")
	assert.Equal(t, []string{"gravatar.example"}, getSettings(t, srv, cookie).ForgejoSkippedAvatarHosts, "GET")
}
