package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The browser trims a username, but the server can't rely on that (#981):
// any client can send "   ", or a name with spaces round it.
func TestUsername_ABlankOneIsRefusedByTheServer(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	adminCookie, _, _ := registerViaRealCeremony(t, srv, testAdmin, testDisplay)

	for name, call := range map[string]func() *http.Response{
		"register begin": func() *http.Response {
			resp, err := http.Post(srv.URL+"/api/auth/register/begin", "application/json", strings.NewReader(`{"username":"   ","displayName":"Someone"}`))
			require.NoError(t, err)

			return resp
		},
		"login begin": func() *http.Response {
			resp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"   "}`))
			require.NoError(t, err)

			return resp
		},
		"invite create": func() *http.Response {
			return doJSON(t, http.MethodPost, srv.URL+"/api/admin/invites", `{"username":"   ","displayName":"Someone"}`, adminCookie)
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := call()
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
}

func TestUsername_PaddingIsTrimmedBeforeTheLookup(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	registerViaRealCeremony(t, srv, testUser, testDisplay)

	resp, err := http.Post(srv.URL+"/api/auth/login/begin", "application/json", strings.NewReader(`{"username":"  `+testUser+`  "}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}
