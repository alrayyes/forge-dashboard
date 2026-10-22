package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"context"
	"database/sql"
	"net"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	_ "modernc.org/sqlite"
)

func TestDrainThenShutdown_FlipsUnreadyBeforeShutdownAndWaitsTheDelay(t *testing.T) {
	t.Parallel()

	var order []string
	start := time.Now()
	var waited time.Duration

	err := drainThenShutdown(30*time.Millisecond,
		func() { order = append(order, "drain") },
		func(context.Context) error {
			waited = time.Since(start)
			order = append(order, "shutdown")

			return nil
		})

	require.NoError(t, err)
	assert.Equal(t, []string{"drain", "shutdown"}, order)
	assert.GreaterOrEqual(t, waited, 30*time.Millisecond)
}

func TestResolveShutdownDrain_NoEnv_UsesDefault(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain(""))
}

func TestResolveShutdownDrain_InvalidOrNegative_UsesDefault(t *testing.T) {
	t.Parallel()

	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain("soon"))
	assert.Equal(t, defaultShutdownDrain, resolveShutdownDrain("-1s"))
}

func TestResolveShutdownDrain_Zero_DisablesTheWait(t *testing.T) {
	t.Parallel()

	assert.Equal(t, time.Duration(0), resolveShutdownDrain("0s"))
}

// A request stuck on a locked database must not hold the stop past the drain:
// serve returns once the server stops accepting, whatever a handler waits on.
func TestServe_ExitsWithinTheDrainWhileAHandlerWaitsOnALockedDatabase(t *testing.T) {
	t.Setenv("SHUTDOWN_DRAIN", "100ms")

	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "app.db")+"?_busy_timeout=10000&_journal_mode=WAL")
	require.NoError(t, err)
	t.Cleanup(func() { _ = db.Close() })
	_, err = db.Exec(`CREATE TABLE t (n INTEGER)`)
	require.NoError(t, err)
	holder, err := db.Conn(t.Context())
	require.NoError(t, err)
	t.Cleanup(func() { _ = holder.Close() })
	_, err = holder.ExecContext(t.Context(), `BEGIN IMMEDIATE`)
	require.NoError(t, err)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close()) // serve binds the address itself
	inHandler := make(chan struct{})
	srv := &http.Server{
		Addr:              addr,
		ReadHeaderTimeout: time.Second,
		Handler: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			close(inHandler)
			_, _ = db.ExecContext(r.Context(), `INSERT INTO t VALUES (1)`)
		}),
	}
	ctx, stop := context.WithCancel(t.Context())
	served := make(chan error, 1)
	go func() { served <- serve(ctx, srv, &api.Drain{}) }()

	go func() {
		resp, err := http.Get("http://" + addr)
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
	<-inHandler

	start := time.Now()
	stop()

	select {
	case err := <-served:
		require.NoError(t, err)
		assert.Less(t, time.Since(start), 2*time.Second, "exit should follow the 100ms drain, not the lock wait")
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return while a handler waited on the lock")
	}
}
