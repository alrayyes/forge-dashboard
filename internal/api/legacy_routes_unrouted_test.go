package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLegacyRoutes_UnknownPath_Is404WithoutARedirect(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			t.Parallel()

			req, err := http.NewRequestWithContext(t.Context(), method, srv.URL+"/api/nope", strings.NewReader("{}"))
			require.NoError(t, err)
			resp, err := noFollowClient(t).Do(req)
			require.NoError(t, err)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusNotFound, resp.StatusCode)
			assert.Empty(t, resp.Header.Get("Deprecation"))
		})
	}
}

func TestLegacyRoutes_FollowedPost_KeepsMethodAndBody(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	body := `{"forge":"github","fullName":"alrayyes/tempus-fugit","number":42}`
	req, err := http.NewRequestWithContext(t.Context(), http.MethodPost, srvURL+"/api/pull-requests/merge", strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	// The v1 handler merged the pull request named in the body, so the
	// redirect kept both the POST and what it carried.
	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 42, source.lastNumber)
}

func TestAPI_NotRoutedPaths_AnswerJSON404(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, path := range []string{"/api/webhooks/github/x", "/api/v1"} {
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
