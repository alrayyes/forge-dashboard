package github_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
)

// syncBuffer is a log sink safe to read while a client writes to it.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.Write(p) //nolint:wrapcheck // a bytes.Buffer write never fails
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.buf.String()
}

func captureUnreachableLogs(t *testing.T) *syncBuffer {
	t.Helper()

	logs := &syncBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	return logs
}

// A failed fetch names the kind of failure, so a false "unreachable" banner
// can be told from a real outage in the log (#4977). These tests set the
// process-wide logger, so they do not run in parallel.
func TestFetch_TheFailureLogNamesTheErrorKind(t *testing.T) {
	t.Run("a gateway error from GitHub", func(t *testing.T) {
		logs := captureUnreachableLogs(t)
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
		}))
		t.Cleanup(srv.Close)

		github.NewClient("test-token", "", srv.URL).Fetch(t.Context())

		assert.Contains(t, logs.String(), "msg=\"forge unreachable\" forge=github error_kind=upstream_error status=502")
	})

	t.Run("a refused connection", func(t *testing.T) {
		logs := captureUnreachableLogs(t)

		github.NewClient("test-token", "", refusedURL).Fetch(t.Context())

		assert.Contains(t, logs.String(), "msg=\"forge unreachable\" forge=github error_kind=unreachable status=0")
	})
}
