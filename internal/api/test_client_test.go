package api_test

import (
	"net/http"
	"testing"
)

// testClient returns an HTTP client with a transport of its own. Tests use it
// instead of the package-level default client because every
// httptest.Server.Close() calls CloseIdleConnections on http.DefaultTransport,
// which fails another parallel test's in-flight request. Call it once per
// test, not inside a retry closure: each call clones a transport.
func testClient(tb testing.TB) *http.Client {
	tb.Helper()

	var transport *http.Transport
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = base.Clone()
	} else {
		transport = &http.Transport{}
	}
	tb.Cleanup(transport.CloseIdleConnections)

	return &http.Client{Transport: transport}
}
