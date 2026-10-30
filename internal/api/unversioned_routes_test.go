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

func TestUnversionedRoutes_OldClientAddress_IsTheJSON404OfAnyUnknownPath(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	tests := []struct {
		method, path string
	}{
		{http.MethodGet, "/api/dashboard?includeDrafts=true"},
		{http.MethodPost, "/api/pull-requests/merge"},
		{http.MethodDelete, "/api/tokens/7"},
		{http.MethodGet, "/api/dashboard/stream"},
		{http.MethodPost, "/api/mcp"},
		{http.MethodGet, "/api/nope"},
		{http.MethodPost, "/api/nope"},
	}
	for _, tt := range tests {
		t.Run(tt.method+" "+tt.path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), tt.method, srv.URL+tt.path, strings.NewReader("{}"))
			require.NoError(t, err)
			resp, err := noFollowClient(t).Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
			assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
			assert.Empty(t, resp.Header.Get("Location"))
			assert.Empty(t, resp.Header.Get("Deprecation"))
		})
	}
}

func TestUnversionedRoutes_UnversionedByDesign_StillAnswer(t *testing.T) {
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

			assert.NotEqual(t, http.StatusNotFound, resp.StatusCode)
			assert.Empty(t, resp.Header.Get("Location"))
			assert.Empty(t, resp.Header.Get("Deprecation"))
		})
	}
}

func TestUnversionedRoutes_WebhookRoute_IsNotRedirected(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, srv.URL+"/api/webhooks/github/nope", strings.NewReader("{}"))
	require.NoError(t, err)
	resp, err := noFollowClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Empty(t, resp.Header.Get("Location"))
}

func TestAPI_NotRoutedPaths_AnswerJSON404(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, path := range []string{"/api/webhooks/github/x", "/api/v1", "/api/v1/nope"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+path, nil)
			require.NoError(t, err)
			resp, err := noFollowClient(t).Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
			assert.Contains(t, resp.Header.Get("Content-Type"), "application/json")
		})
	}
}
