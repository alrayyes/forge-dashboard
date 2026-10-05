package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"database/sql"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/auth"
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

func TestRunHealthcheckSucceedsWhenReadyzAnswers200(t *testing.T) {
	l := listenOnFreePort(t)

	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })

	require.NoError(t, runHealthcheck())
}

func TestRunHealthcheckFailsWhenReadyzAnswersNon200(t *testing.T) {
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

// serveRoutes serves the given status per path and 404 for anything else,
// so a probe aimed at the wrong endpoint fails the test.
func serveRoutes(t *testing.T, routes map[string]int) {
	t.Helper()

	l := listenOnFreePort(t)
	mux := http.NewServeMux()
	for path, status := range routes {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })
	}
	srv := &http.Server{ReadHeaderTimeout: time.Second, Handler: mux}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
}

func TestRunHealthcheckProbesReadyzNotHealthz(t *testing.T) {
	// /healthz would say 200 here; only /readyz's 503 may decide the result.
	serveRoutes(t, map[string]int{"/healthz": http.StatusOK, "/readyz": http.StatusServiceUnavailable})

	err := runHealthcheck()

	require.ErrorIs(t, err, errReadyzStatus)
}

func TestRunHealthcheckSucceedsOnReadyz200EvenIfHealthzIsNot(t *testing.T) {
	serveRoutes(t, map[string]int{"/readyz": http.StatusOK})

	require.NoError(t, runHealthcheck())
}

func TestSchemaPinger_MigratedDatabase_Passes(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	require.NoError(t, auth.NewStore(db).Init(t.Context()))

	require.NoError(t, schemaPinger{db: db}.PingContext(t.Context()))
}

func TestSchemaPinger_DatabaseWithoutSchema_Fails(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "empty.db"))
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })

	require.Error(t, schemaPinger{db: db}.PingContext(t.Context()))
}

func TestSchemaPinger_ClosedDatabase_Fails(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db"))
	require.NoError(t, err)
	require.NoError(t, db.Close())

	require.Error(t, schemaPinger{db: db}.PingContext(t.Context()))
}
