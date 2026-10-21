package github_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type memBacking struct {
	mu   sync.Mutex
	rows map[string]memRow
}

type memRow struct {
	etag   string
	body   []byte
	header map[string][]string
}

func (m *memBacking) key(forge, credential, url, accept string) string {
	return forge + "|" + credential + "|" + url + "|" + accept
}

func (m *memBacking) LoadETag(_ context.Context, forge, credential, url, accept string) (string, []byte, map[string][]string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[m.key(forge, credential, url, accept)]

	return r.etag, r.body, r.header, ok, nil
}

func (m *memBacking) SaveETag(_ context.Context, forge, credential, url, accept, etag string, body []byte, header map[string][]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string]memRow{}
	}
	m.rows[m.key(forge, credential, url, accept)] = memRow{etag: etag, body: body, header: header}

	return nil
}

func etagServer(t *testing.T) (srv *httptest.Server, conditional *atomic.Int32) {
	t.Helper()
	conditional = new(atomic.Int32)
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == `"v1"` {
			conditional.Add(1)
			w.WriteHeader(http.StatusNotModified)

			return
		}
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte("payload"))
	}))
	t.Cleanup(srv.Close)

	return srv, conditional
}

func getVia(t *testing.T, rt http.RoundTripper, url string) string {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)
	resp, err := rt.RoundTrip(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return string(body)
}

// A restart empties the in-memory store; the persisted row brings the ETag
// back, so the first request after it is conditional.
func TestETagTransport_AfterARestart_SendsThePersistedETag(t *testing.T) {
	t.Parallel()
	srv, conditional := etagServer(t)
	backing := &memBacking{}
	getVia(t, github.NewBackedETagTransport(nil, "token:x", backing), srv.URL)

	body := getVia(t, github.NewBackedETagTransport(nil, "token:x", backing), srv.URL)

	assert.EqualValues(t, 1, conditional.Load())
	assert.Equal(t, "payload", body, "the 304 is answered from the persisted body")
}

func TestETagTransport_AfterARestart_AnotherCredentialSendsNothing(t *testing.T) {
	t.Parallel()
	srv, conditional := etagServer(t)
	backing := &memBacking{}
	getVia(t, github.NewBackedETagTransport(nil, "token:x", backing), srv.URL)

	getVia(t, github.NewBackedETagTransport(nil, "token:y", backing), srv.URL)

	assert.Zero(t, conditional.Load())
}
