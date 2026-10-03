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
