package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// No image loads from a host the browser would have to contact itself (#3467):
// every response names this server alone as an image source, so a renderer bug
// that emitted a direct <img> would be refused by the browser, not just by us.
func TestContentSecurityPolicy_EveryResponseNamesThisServerAsTheOnlyImageSource(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{Transport: testClient(t).Transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}

	for _, path := range []string{
		"/login.html",
		"/style.css",
		"/healthz",
		"/api/version",
		"/api/v1/dashboard", // JSON 401
		"/settings.html",    // auth-gated page, redirected
		"/no-such-page",
	} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			resp, err := client.Get(srv.URL + path)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, "img-src 'self' data:", resp.Header.Get("Content-Security-Policy"))
		})
	}
}
