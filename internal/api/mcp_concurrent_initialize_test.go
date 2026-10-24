package api_test

import (
	"net/http"
	"sync"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
)

// Sixteen sessions opening at once on one token each write the token's
// last-used time. That only works when the database waits out a busy lock the
// way production's does, so this pins that the test server opens SQLite the
// same way.
func TestMCP_Initialize_ManyParallelSessionsOnOneTokenAllSucceed(t *testing.T) {
	t.Parallel()

	const sessions = 16

	srv := newTestServer(t)
	sessionCookie, _, _ := registerViaRealCeremony(t, srv)
	token := createAPIToken(t, srv.URL, sessionCookie)

	errs := make([]error, sessions)
	var wg sync.WaitGroup
	for i := range sessions {
		wg.Go(func() {
			client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "v0.0.0"}, nil)
			transport := &mcp.StreamableClientTransport{
				Endpoint:   srv.URL + "/api/mcp",
				HTTPClient: &http.Client{Transport: bearerRoundTripper{token: token, base: http.DefaultTransport.(*http.Transport).Clone()}},
			}
			session, err := client.Connect(t.Context(), transport, nil)
			if err == nil {
				_ = session.Close()
			}
			errs[i] = err
		})
	}
	wg.Wait()

	for i, err := range errs {
		assert.NoError(t, err, "session %d", i)
	}
}
