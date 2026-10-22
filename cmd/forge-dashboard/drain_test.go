package main

// This file is package main, not main_test, on purpose: it tests unexported
// functions of the program itself, and another package can't import package
// main. Anything that can live in a library package is tested there instead
// (rules/go-test.md prefers the external test package).

import (
	"io"
	"net"
	"net/http"

	"context"
	"github.com/alrayyes/forge-dashboard/internal/api"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
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

// startServe runs serve on a free port with handler and returns the base URL,
// the cancel that asks it to stop, and a channel that closes once serve returns.
func startServe(t *testing.T, handler http.Handler) (string, context.CancelFunc, <-chan struct{}) {
	t.Helper()
	t.Setenv("SHUTDOWN_DRAIN", "0s")

	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())

	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = serve(ctx, srv, &api.Drain{})
	}()

	require.Eventually(t, func() bool {
		c, err := net.Dial("tcp", addr)
		if err != nil {
			return false
		}
		_ = c.Close()

		return true
	}, 2*time.Second, 10*time.Millisecond)

	return "http://" + addr, cancel, done
}

func TestServe_InFlightRequest_FinishesBeforeServeReturns(t *testing.T) {
	started := make(chan struct{})
	base, cancel, done := startServe(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		time.Sleep(time.Second)
		_, _ = w.Write([]byte("done"))
	}))

	type result struct {
		body string
		err  error
	}
	res := make(chan result, 1)
	go func() {
		resp, err := http.Get(base)
		if err != nil {
			res <- result{err: err}

			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		res <- result{body: string(b), err: err}
	}()

	<-started
	cancel()

	select {
	case <-done:
		t.Fatal("serve returned while a request was still in flight")
	case <-time.After(300 * time.Millisecond):
	}

	r := <-res
	require.NoError(t, r.err)
	assert.Equal(t, "done", r.body)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("serve did not return after the request finished")
	}
}

func TestServe_RequestOutlastingTheDrain_ServeReturnsWithinTheShutdownTimeout(t *testing.T) {
	old := shutdownTimeout
	shutdownTimeout = 200 * time.Millisecond
	t.Cleanup(func() { shutdownTimeout = old })

	started := make(chan struct{})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	base, cancel, done := startServe(t, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
	}))

	go func() {
		resp, err := http.Get(base)
		if err == nil {
			_ = resp.Body.Close()
		}
	}()
	<-started
	begin := time.Now()
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("serve did not return after the shutdown timeout")
	}
	assert.GreaterOrEqual(t, time.Since(begin), 150*time.Millisecond)
}
