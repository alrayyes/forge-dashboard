package main

import (
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// listenOnFreePort binds ADDR to an actual free loopback port for the
// duration of t - runHealthcheck reads that env var directly, it doesn't
// take a flag.
func listenOnFreePort(t *testing.T) net.Listener {
	t.Helper()

	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() { _ = l.Close() })

	t.Setenv("ADDR", l.Addr().String())

	return l
}

func TestRunHealthcheckSucceedsWhenHealthzAnswers200(t *testing.T) {
	l := listenOnFreePort(t)

	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	require.NoError(t, runHealthcheck())
}

func TestRunHealthcheckFailsWhenHealthzAnswersNon200(t *testing.T) {
	l := listenOnFreePort(t)

	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	require.Error(t, runHealthcheck())
}

func TestRunHealthcheckFailsWhenNothingIsListening(t *testing.T) {
	// A free port that was bound and immediately released, rather than
	// listenOnFreePort - nothing serves it, which is the failure mode the
	// container's own HEALTHCHECK is there to catch.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())

	t.Setenv("ADDR", addr)

	require.Error(t, runHealthcheck())
}

func TestRunHealthcheckFallsBackToDefaultAddrWhenEnvUnset(t *testing.T) {
	// run's own default is ":8080" - nothing should be listening there in
	// a test process, so this just proves the fallback is used (a
	// connection-refused error) rather than an empty-addr parse error.
	require.Error(t, runHealthcheck())
}
