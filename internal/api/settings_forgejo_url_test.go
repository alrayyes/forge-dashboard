package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSettingsPut_ForgejoURL_RefusesCredentialsAndOddURLsNamingTheField(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	//nolint:gosec // the passwords here are the fixtures under test
	for name, url := range map[string]string{
		"a username":              "https://user@git.example.com",
		"a username and password": "https://user:s3cret@git.example.com/base",
		"an empty username":       "https://:s3cret@git.example.com",
		"a query string":          "https://git.example.com/?token=abc",
		"an empty query string":   "https://git.example.com/?",
		"a fragment":              "https://git.example.com/#abc",
		"an empty fragment":       "https://git.example.com/#",
		"a javascript scheme":     "javascript:alert(1)",
		"a file scheme":           "file:///etc/passwd",
		"an ftp scheme":           "ftp://git.example.com",
		"no scheme":               "git.example.com",
		"no host":                 "https://",
		"an unparseable URL":      "https://git.exa mple.com:s3cret@x",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			status, body := putSettings(t, srv.URL, `{"forgejoUrl":"`+url+`"}`, cookie)
			assert.Equal(t, http.StatusBadRequest, status)
			assert.Equal(t, "forgejoUrl", body["field"])
			assert.NotContains(t, body["error"], "s3cret", "the error must not echo the URL")
			assert.NotContains(t, body["error"], "token=abc")
		})
	}
}

func TestSettingsPut_ForgejoURL_RefusedURLStoresNothing(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	status, _ := putSettings(t, srv.URL, `{"forgejoUrl":"https://git.example.com"}`, cookie)
	require.Equal(t, http.StatusOK, status)

	status, _ = putSettings(t, srv.URL, `{"forgejoUrl":"https://user:s3cret@other.example.com"}`, cookie)
	require.Equal(t, http.StatusBadRequest, status)

	assert.Equal(t, "https://git.example.com", getSettings(t, srv.URL, cookie).ForgejoURL)
}

func TestSettingsPut_ForgejoURL_AcceptsPlainAndPathPrefixedURLs(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	for _, url := range []string{
		"", "https://git.example.com", "https://git.example.com/", "https://git.example.com/base/path",
		"http://localhost:3000", "https://git.example.com:8443/forgejo",
	} {
		status, body := putSettings(t, srv.URL, `{"forgejoUrl":"`+url+`"}`, cookie)
		require.Equal(t, http.StatusOK, status, "%q: %v", url, body)
		assert.Equal(t, url, getSettings(t, srv.URL, cookie).ForgejoURL)
	}
}
