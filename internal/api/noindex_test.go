package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// An internal tool stays out of search results (#1285): every response says
// so, whatever it is: a page, a script, JSON, a redirect or an error.
func TestNoIndex_EveryResponseCarriesTheHeader(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	for _, path := range []string{
		"/login.html",    // public page
		"/style.css",     // static asset
		"/healthz",       // plain handler
		"/api/version",   // JSON
		"/api/nope",      // JSON 404
		"/api/dashboard", // JSON 401
		"/settings.html", // auth-gated page, redirected
		"/no-such-page",  // the 404 page
		"/robots.txt",    // crawlers read this first
	} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			resp, err := client.Get(srv.URL + path)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, "noindex, nofollow", resp.Header.Get("X-Robots-Tag"))
		})
	}
}

// robots.txt must not Disallow: a crawler that can't fetch a page never sees
// its noindex.
func TestNoIndex_RobotsTxtAllowsCrawling(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Get(srv.URL + "/robots.txt") //nolint:noctx // test against a local server
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	body := make([]byte, 512)
	n, _ := resp.Body.Read(body)
	assert.NotContains(t, string(body[:n]), "Disallow: /")
}
