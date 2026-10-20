package github_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// get sends one GET through rt and returns the whole body.
func get(t *testing.T, rt http.RoundTripper, url, accept string) string {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, nil)
	require.NoError(t, err)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := rt.RoundTrip(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return string(b)
}

func TestETagCache_SameURLDifferentAccept_GetsItsOwnEntry(t *testing.T) {
	t.Parallel()

	// The body depends on Accept but the ETag does not, so a cache that ignored
	// Accept would be told "not modified" and hand back the wrong body.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept := r.Header.Get("Accept")
		const etag = `"same"`
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)

			return
		}
		w.Header().Set("ETag", etag)
		bodies := map[string]string{"application/json": "json body", "application/vnd.github.diff": "diff body"}
		_, _ = io.WriteString(w, bodies[accept])
	}))
	defer srv.Close()

	client := github.NewClient("accept-token", "", srv.URL)
	rt := client.ETagTransport()

	get(t, rt, srv.URL+"/thing", "application/json")
	get(t, rt, srv.URL+"/thing", "application/vnd.github.diff")

	assert.Equal(t, "json body", get(t, rt, srv.URL+"/thing", "application/json"))
	assert.Equal(t, "diff body", get(t, rt, srv.URL+"/thing", "application/vnd.github.diff"))
}

func TestETagCache_ReplacedEntry_ByteTotalEqualsLiveBodies(t *testing.T) {
	t.Parallel()

	var size atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Always a 200 with a new ETag, so the entry is replaced each time.
		n := int(size.Load())
		w.Header().Set("ETag", `"`+strconv.Itoa(n)+`"`)
		_, _ = io.WriteString(w, strings.Repeat("x", n))
	}))
	defer srv.Close()

	client := github.NewClient("bytes-replace-token", "", srv.URL)
	client.UseETagStoreLimits(1000, 1<<20) // a private store, so only this test's entry is in it
	rt := client.ETagTransport()

	for _, n := range []int64{100, 40} {
		size.Store(n)
		get(t, rt, srv.URL+"/thing", "")
	}

	tracked, live := client.ETagStoreBytes()
	require.Equal(t, 40, live)
	assert.Equal(t, live, tracked)
}
