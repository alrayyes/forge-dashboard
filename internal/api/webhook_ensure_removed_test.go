package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The dashboard creates and repairs webhooks itself, and no screen called
// POST /api/v1/webhooks/ensure once the Webhooks page went. These pin that
// the endpoint stays gone, in the spec and on the mux.

func TestWebhookEnsure_IsNotInTheSpec(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)

	assert.Nil(t, doc.Paths.Find("/api/v1/webhooks/ensure"))
}

func TestWebhookEnsure_IsNotRouted(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/api/v1/webhooks/ensure",
		strings.NewReader(`{"forge":"github","fullName":"alrayyes/a"}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")

	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Contains(t, []int{http.StatusNotFound, http.StatusMethodNotAllowed}, resp.StatusCode)
}
