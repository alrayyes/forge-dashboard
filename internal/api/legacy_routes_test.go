package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func noFollowClient(t *testing.T) *http.Client {
	t.Helper()

	c := testClient(t)
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	return c
}

func TestLegacyRoutes_UnversionedClientRoute_Answers308ToV1(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	tests := []struct {
		method, path, want string
	}{
		{http.MethodGet, "/api/dashboard?includeDrafts=true", "/api/v1/dashboard?includeDrafts=true"},
		{http.MethodPost, "/api/pull-requests/merge", "/api/v1/pull-requests/merge"},
		{http.MethodDelete, "/api/tokens/7", "/api/v1/tokens/7"},
		{http.MethodGet, "/api/dashboard/stream", "/api/v1/dashboard/stream"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), tt.method, srv.URL+tt.path, strings.NewReader("{}"))
			require.NoError(t, err)
			resp, err := noFollowClient(t).Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusPermanentRedirect, resp.StatusCode)
			assert.Equal(t, tt.want, resp.Header.Get("Location"))
			assert.Regexp(t, `^@\d+$`, resp.Header.Get("Deprecation"))
			assert.Contains(t, resp.Header.Get("Link"), `rel="successor-version"`)
		})
	}
}

func TestLegacyRoutes_UnversionedByDesign_AreNotRedirected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, path := range []string{"/healthz", "/readyz", "/api/version"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+path, nil)
			require.NoError(t, err)
			resp, err := noFollowClient(t).Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.NotEqual(t, http.StatusPermanentRedirect, resp.StatusCode)
			assert.Empty(t, resp.Header.Get("Deprecation"))
		})
	}
}

func TestLegacyRoutes_WebhookRoute_IsNotRedirected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, srv.URL+"/api/webhooks/github/nope", strings.NewReader("{}"))
	require.NoError(t, err)
	resp, err := noFollowClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.NotEqual(t, http.StatusPermanentRedirect, resp.StatusCode)
}

func TestLegacyRoutes_VersionedUnknownPath_Is404NotARedirectLoop(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+"/api/v1/nope", nil)
	require.NoError(t, err)
	resp, err := noFollowClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}
