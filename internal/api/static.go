package api

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"github.com/CAFxX/httpcompression"
)

const (
	// A content-addressed file never changes under its URL, so a year and
	// `immutable` (which stops reloads revalidating it) is the standard answer.
	cacheImmutable = "public, max-age=31536000, immutable"
	// Everything else can't be cache-busted, so it is stored but revalidated
	// each time: a cheap 304 against the ETag, never a stale page.
	cacheRevalidate = "no-cache"
	// Pages built from a visitor's session may sit in their own browser cache
	// but never in a shared one.
	cacheRevalidatePrivate = "private, no-cache"

	// SvelteKit writes every hashed file under this directory, and only those.
	// Match on the directory, not an extension (rules/web-performance.md).
	immutablePrefix = "_app/immutable/"

	// Below this a compressed body saves less than the headers cost. Lighthouse
	// itself ignores anything under about 1.4 KiB.
	compressMinSize = 1024
	brotliLevel     = 5 // the encoder's default is 6; 11 is far too slow per request
	gzipLevel       = 6
)

// compressibleTypes is the allow-list: text the frontend ships. Images, fonts
// and archives are already compressed, so recompressing them costs CPU for
// nothing.
var compressibleTypes = []string{
	"text/html",
	"text/css",
	"text/plain",
	"text/javascript",
	"application/javascript",
	"application/json",
	"application/manifest+json",
	"image/svg+xml",
	"application/xml",
	"text/xml",
}

// newStaticHandler serves the embedded frontend with the headers a browser
// needs to cache it well (#1069): immutable for the hashed build output, a
// revalidated ETag for the rest, brotli or gzip for text. private marks the
// pages that sit behind a session.
//
// Compression wraps only this handler. The API, including the SSE streams,
// stays outside it, since a buffering compressor is the wrong thing to put in
// front of an event stream and JSON that carries account data is the usual
// target of compression-length attacks.
func newStaticHandler(fsys fs.FS, private bool) http.Handler {
	compress, err := httpcompression.Adapter(
		httpcompression.GzipCompressionLevel(gzipLevel),
		httpcompression.BrotliCompressionLevel(brotliLevel),
		httpcompression.MinSize(compressMinSize),
		httpcompression.ContentTypes(compressibleTypes, false),
	)
	if err != nil {
		// Only possible with a bad level above: a programming error, caught by
		// the first test that builds the mux.
		panic(err)
	}

	revalidate := cacheRevalidate
	if private {
		revalidate = cacheRevalidatePrivate
	}

	return compress(withCacheHeaders(fsys, revalidate, http.FileServerFS(fsys)))
}

// withCacheHeaders sets Cache-Control and a weak ETag for files that exist.
// It decides before serving, from the embedded file set, so a 404 never picks
// up a year-long lifetime. The ETag is weak because the body may be sent
// compressed or not, which makes the bytes differ, not the resource.
func withCacheHeaders(fsys fs.FS, revalidate string, next http.Handler) http.Handler {
	etags := map[string]string{}

	_ = fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // an unreadable entry just goes without an ETag
		}
		data, readErr := fs.ReadFile(fsys, name)
		if readErr != nil {
			return nil //nolint:nilerr // as above
		}
		sum := sha256.Sum256(data)
		etags[name] = `W/"` + hex.EncodeToString(sum[:8]) + `"`

		return nil
	})

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}

		if etag, ok := etags[name]; ok {
			switch {
			case strings.HasPrefix(name, immutablePrefix):
				w.Header().Set("Cache-Control", cacheImmutable)
			default:
				w.Header().Set("Cache-Control", revalidate)
			}
			w.Header().Set("ETag", etag)
		}

		next.ServeHTTP(w, r)
	})
}
