package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"context"
	"database/sql"
	"io"
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

	err := drainThenShutdown(nil, 30*time.Millisecond, time.Second,
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

func TestDrainThenShutdown_AbortedDuringTheDelay_DoesNotShutDown(t *testing.T) {
	t.Parallel()

	abort := make(chan struct{})
	close(abort)
	shutDown := false

	err := drainThenShutdown(abort, time.Minute, time.Second, func() {}, func(context.Context) error {
		shutDown = true

		return nil
	})

	require.NoError(t, err)
	assert.False(t, shutDown)
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

// startServe runs serve on a listener it owns, with handler, and returns the
// base URL, the cancel that asks it to stop, and a channel that closes once
// serve returns.
func startServe(t *testing.T, handler http.Handler, timeout time.Duration, stopStreams func()) (string, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	t.Setenv("SHUTDOWN_DRAIN", "0s")

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	srv := &http.Server{Handler: handler, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = serve(ctx, srv, ln, &api.Drain{}, timeout, stopStreams)
	}()

	t.Cleanup(func() {
		cancel()
		<-done
	})

	return "http://" + ln.Addr().String(), cancel, done
}

type result struct {
	body string
	err  error
}

// getAsync fetches url in the background, bounded so a regression fails the
// test instead of hanging it.
func getAsync(url string) <-chan result {
	res := make(chan result, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, http.NoBody)
		if err != nil {
			res <- result{err: err}

			return
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			res <- result{err: err}

			return
		}
		defer func() { _ = resp.Body.Close() }()
		b, err := io.ReadAll(resp.Body)
		res <- result{body: string(b), err: err}
	}()

	return res
}

func waitClosed(t *testing.T, ch <-chan struct{}, d time.Duration, msg string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(d):
		t.Fatal(msg)
	}
}

func TestServe_InFlightRequest_FinishesBeforeServeReturns(t *testing.T) {
	started := make(chan struct{})
	base, cancel, done := startServe(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		time.Sleep(time.Second)
		_, _ = w.Write([]byte("done"))
	}), 5*time.Second, nil)

	res := getAsync(base)
	waitClosed(t, started, 2*time.Second, "handler never started")
	cancel()

	select {
	case <-done:
		t.Fatal("serve returned while a request was still in flight")
	case <-time.After(300 * time.Millisecond):
	}

	r := <-res
	require.NoError(t, r.err)
	assert.Equal(t, "done", r.body)
	waitClosed(t, done, 3*time.Second, "serve did not return after the request finished")
}

func TestServe_RequestOutlastingTheDrain_ServeReturnsWithinTheShutdownTimeout(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	base, cancel, done := startServe(t, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
	}), 200*time.Millisecond, nil)

	_ = getAsync(base)
	waitClosed(t, started, 2*time.Second, "handler never started")
	begin := time.Now()
	cancel()

	waitClosed(t, done, 2*time.Second, "serve did not return after the shutdown timeout")
	assert.GreaterOrEqual(t, time.Since(begin), 150*time.Millisecond)
}

// An open event stream never ends on its own, so shutdown has to end it or
// every restart waits out the full timeout.
func TestServe_OpenStream_IsEndedAsShutdownBeginsSoServeReturnsAtOnce(t *testing.T) {
	started := make(chan struct{})
	stop := make(chan struct{})
	base, cancel, done := startServe(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		close(started)
		<-stop
	}), 10*time.Second, func() { close(stop) })

	_ = getAsync(base)
	waitClosed(t, started, 2*time.Second, "stream never opened")
	begin := time.Now()
	cancel()

	waitClosed(t, done, 3*time.Second, "serve waited out the shutdown timeout on an open stream")
	assert.Less(t, time.Since(begin), 2*time.Second)
}

func TestServe_ListenerFails_ReturnsTheErrorAndDoesNotLeakTheShutdownWaiter(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	require.NoError(t, ln.Close())

	err = serve(context.Background(), &http.Server{ReadHeaderTimeout: time.Second}, ln, &api.Drain{}, time.Second, nil)

	require.Error(t, err)
	assert.Contains(t, err.Error(), "server stopped")
}

// A request stuck on a locked database must not hold the stop past the drain:
// serve returns once the shutdown timeout is up, whatever a handler waits on.
func TestServe_ExitsWithinTheTimeoutWhileAHandlerWaitsOnALockedDatabase(t *testing.T) {
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

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := ln.Addr().String()
	inHandler := make(chan struct{})
	srv := &http.Server{
		ReadHeaderTimeout: time.Second,
		Handler: http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			close(inHandler)
			_, _ = db.ExecContext(r.Context(), `INSERT INTO t VALUES (1)`)
		}),
	}
	ctx, stop := context.WithCancel(t.Context())
	served := make(chan error, 1)
	go func() { served <- serve(ctx, srv, ln, &api.Drain{}, 200*time.Millisecond, nil) }()

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
		assert.Less(t, time.Since(start), 2*time.Second, "exit should follow the drain and the 200ms timeout, not the lock wait")
	case <-time.After(5 * time.Second):
		t.Fatal("serve did not return while a handler waited on the lock")
	}
}
