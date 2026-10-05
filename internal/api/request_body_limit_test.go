package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// No JSON endpoint should read an unbounded body (#1008), so a body past the
// cap is refused before the handler reads it.
func TestRequestBody_OverTheCapIsRefusedWith413(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	huge := `{"githubToken":"` + strings.Repeat("a", 2<<20) + `"}`

	for name, call := range map[string]func() *http.Response{
		"settings (session)": func() *http.Response {
			return doJSON(t, http.MethodPut, srv.URL+"/api/settings", huge, cookie)
		},
		"login begin (public)": func() *http.Response {
			resp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(huge))
			require.NoError(t, err)

			return resp
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := call()
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
		})
	}
}

func TestRequestBody_AnOrdinaryBodyStillGoesThrough(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+strings.Repeat("a", 4096)+`"}`, cookie)
	defer func() { _ = resp.Body.Close() }()

	assert.NotEqual(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
}

// A forge's webhook payload can be large; that route keeps its own, bigger
// cap (maxWebhookBodyBytes) and isn't held to the JSON API's.
func TestRequestBody_WebhookRoutesKeepTheirOwnCap(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/api/webhooks/github/some-token", "application/json", strings.NewReader(strings.Repeat("a", 2<<20)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.NotEqual(t, http.StatusRequestEntityTooLarge, resp.StatusCode)
}
