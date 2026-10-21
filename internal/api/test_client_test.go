package api_test

import (
	"net/http"
	"testing"
)

// testClient returns an HTTP client with a transport of its own. Tests use it
// instead of http.DefaultClient or http.Get because every
// httptest.Server.Close() calls CloseIdleConnections on http.DefaultTransport,
// which fails another parallel test's in-flight request.
func testClient(tb testing.TB) *http.Client {
	tb.Helper()

	transport := http.DefaultTransport.(*http.Transport).Clone() //nolint:forcetypeassert // the stdlib default is always a *http.Transport
	tb.Cleanup(transport.CloseIdleConnections)

	return &http.Client{Transport: transport}
}
