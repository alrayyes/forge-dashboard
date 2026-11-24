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
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, path := range []string{
		"/",
		"/issues.html",
		"/insights.html",
		"/releases.html",
		"/bots.html",
		"/pull-requests.html",
		"/settings.html",
		"/changelog.html",
		"/changelog.json",
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

// The changelog's newest entry is the running version, so the page and its
// data need a session too (#4426). A signed-in visitor is not bounced.
func TestChangelog_WithASession_IsNotBounced(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, path := range []string{"/changelog.html", "/changelog.json"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+path, nil)
			require.NoError(t, err)
			req.AddCookie(sessionCookie)
			resp, err := client.Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.NotEqual(t, http.StatusFound, resp.StatusCode)
			assert.Empty(t, resp.Header.Get("Location"))
		})
	}
}

// The Admin page held the user list and the invites, which are gone, so its
// address is an ordinary 404 now instead of a page behind a login.
func TestAdminPage_IsGone(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, path := range []string{"/admin.html", "/admin.js"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			resp, err := client.Get(srv.URL + path)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
		})
	}
}

// The branch page used to live at /main-branches.html and is the index now
// (#1279); the old address sends a bookmark there.
func TestMainBranchesPage_OldAddressRedirectsToTheIndex(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	resp, err := client.Get(srv.URL + "/main-branches.html")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusMovedPermanently, resp.StatusCode)
	assert.Equal(t, "/", resp.Header.Get("Location"))
}

// The Webhooks page is gone (#4029); its controls are in Settings, under
// Repositories. A saved link to either spelling lands there, not on a 404.
func TestWebhooksPage_OldAddressesRedirectToSettingsRepositories(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	for _, path := range []string{"/webhooks.html", "/webhooks"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			resp, err := client.Get(srv.URL + path)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusMovedPermanently, resp.StatusCode)
			assert.Equal(t, "/settings.html#repositories", resp.Header.Get("Location"))
		})
	}
}
