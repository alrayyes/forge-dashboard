package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDrainThenShutdown_FlipsUnreadyBeforeShutdownAndWaitsTheDelay(t *testing.T) {
	t.Parallel()

	var order []string
	start := time.Now()
	var waited time.Duration

	err := drainThenShutdown(30*time.Millisecond, time.Second,
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
