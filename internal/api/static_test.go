package api_test

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Headers the static frontend must carry (#1069): hashed assets cached for a
// year, everything else revalidated, text compressed, the rest left alone.

const hashedJS = "/_app/immutable/entry/app.4f9a1c.js"

func staticFixture() fstest.MapFS {
	body := func(s string) []byte { return []byte(strings.Repeat(s, 400)) }

	return fstest.MapFS{
		"index.html":                         {Data: body("<p>hello</p>")},
		"login.html":                         {Data: body("<p>sign in</p>")},
		"_app/immutable/entry/app.4f9a1c.js": {Data: body("export const a = 1;\n")},
		"_app/immutable/assets/0.9b2e.css":   {Data: body("a{color:red}\n")},
		"data.json":                          {Data: body(`{"a":1}`)},
		"favicon.svg":                        {Data: body("<svg></svg>")},
		"humans.txt":                         {Data: body("hi\n")},
		"logo.png":                           {Data: body("\x89PNG")},
		"tiny.css":                           {Data: []byte("a{}")},
	}
}

// get sends one request straight to the handler, so the test sees exactly
// what would go on the wire, with no client-side decompression in between.
func get(h http.Handler, path, acceptEncoding string, extra ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	for i := 0; i+1 < len(extra); i += 2 {
		req.Header.Set(extra[i], extra[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	return rec
}

func TestStatic_HashedAssetsAreImmutable(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	for _, path := range []string{hashedJS, "/_app/immutable/assets/0.9b2e.css"} {
		resp := get(h, path, "")
		assert.Equal(t, http.StatusOK, resp.Code, path)
		assert.Equal(t, "public, max-age=31536000, immutable", resp.Header().Get("Cache-Control"), path)
	}
}

func TestStatic_UnhashedFilesRevalidate(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	for _, path := range []string{"/login.html", "/favicon.svg", "/humans.txt", "/"} {
		resp := get(h, path, "")
		assert.Equal(t, http.StatusOK, resp.Code, path)
		assert.Equal(t, "no-cache", resp.Header().Get("Cache-Control"), path)
		assert.NotEmpty(t, resp.Header().Get("ETag"), path)
	}
}

func TestStatic_PersonalisedPagesArePrivate(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), true)

	resp := get(h, "/", "")
	assert.Equal(t, "private, no-cache", resp.Header().Get("Cache-Control"))
}

func TestStatic_ConditionalRequestGets304(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)
	etag := get(h, "/login.html", "gzip").Header().Get("ETag")
	require.NotEmpty(t, etag)

	resp := get(h, "/login.html", "gzip", "If-None-Match", etag)
	assert.Equal(t, http.StatusNotModified, resp.Code)
}

func TestStatic_MissingFileIsNeverCached(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	resp := get(h, "/_app/immutable/entry/gone.js", "")
	assert.Equal(t, http.StatusNotFound, resp.Code)
	assert.Empty(t, resp.Header().Get("Cache-Control"))
}

func TestStatic_TextIsCompressed(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	for _, path := range []string{"/login.html", hashedJS, "/_app/immutable/assets/0.9b2e.css", "/data.json", "/favicon.svg", "/humans.txt"} {
		resp := get(h, path, "br, gzip")
		assert.Equal(t, "br", resp.Header().Get("Content-Encoding"), path)
		assert.Contains(t, resp.Header().Values("Vary"), "Accept-Encoding", path)
	}
}

func TestStatic_GzipFallbackDecodesToTheOriginal(t *testing.T) {
	t.Parallel()

	fsys := staticFixture()
	h := api.NewStaticHandler(fsys, false)

	resp := get(h, "/login.html", "gzip")
	require.Equal(t, "gzip", resp.Header().Get("Content-Encoding"))

	zr, err := gzip.NewReader(resp.Body)
	require.NoError(t, err)
	got, err := io.ReadAll(zr)
	require.NoError(t, err)
	assert.Equal(t, fsys["login.html"].Data, got)
}

func TestStatic_LeavesTheRestAlone(t *testing.T) {
	t.Parallel()

	h := api.NewStaticHandler(staticFixture(), false)

	// No Accept-Encoding: sent as is, but a cache still has to key on it.
	resp := get(h, "/login.html", "")
	assert.Empty(t, resp.Header().Get("Content-Encoding"))
	assert.Contains(t, resp.Header().Values("Vary"), "Accept-Encoding")

	// A type that is already compressed.
	resp = get(h, "/logo.png", "br, gzip")
	assert.Empty(t, resp.Header().Get("Content-Encoding"))

	// Too small to be worth it.
	resp = get(h, "/tiny.css", "br, gzip")
	assert.Empty(t, resp.Header().Get("Content-Encoding"))
}

// The assembled server: the real embedded files get the headers, and the API
// (JSON, SSE) stays outside the compression layer.
func TestStatic_ServerWiring(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}}

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/style.css", nil)
	require.NoError(t, err)
	req.Header.Set("Accept-Encoding", "br, gzip")
	resp, err := client.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "br", resp.Header.Get("Content-Encoding"))

	req, err = http.NewRequest(http.MethodGet, srv.URL+"/api/version", nil)
	require.NoError(t, err)
	req.Header.Set("Accept-Encoding", "br, gzip")
	apiResp, err := client.Do(req)
	require.NoError(t, err)
	defer func() { _ = apiResp.Body.Close() }()
	assert.Empty(t, apiResp.Header.Get("Content-Encoding"))
}
