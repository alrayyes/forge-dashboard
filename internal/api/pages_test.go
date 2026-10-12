package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A page that shows account data is bounced to the login page for a visitor
// with no session, instead of being served as an empty shell (#827 adds
// /issues.html to the list).
func TestPages_RequireASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, path := range []string{
		"/",
		"/issues.html",
		"/insights.html",
		"/releases.html",
		"/bots.html",
		"/pull-requests.html",
		"/settings.html",
		"/webhooks.html",
		"/admin.html",
	} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			resp, err := client.Get(srv.URL + path)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusFound, resp.StatusCode)
			assert.Equal(t, "/login.html", resp.Header.Get("Location"))
		})
	}
}

// The branch page used to live at /main-branches.html and is the index now
// (#1279); the old address sends a bookmark there.
func TestMainBranchesPage_OldAddressRedirectsToTheIndex(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	resp, err := client.Get(srv.URL + "/main-branches.html")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusMovedPermanently, resp.StatusCode)
	assert.Equal(t, "/", resp.Header.Get("Location"))
}
