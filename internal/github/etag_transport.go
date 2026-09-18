package github

import (
	"bytes"
	"io"
	"net/http"
	"sync"
)

// etagTransport wraps another http.RoundTripper with a per-URL ETag cache
// for GET requests — GitHub doesn't charge a 304 response against the
// REST rate limit, unlike a full 200, so a repeat call for data that
// hasn't changed (checkWebhooks' own ListHooks call runs once per
// tracked repo on every poll) can come back free instead (#381).
//
// Scoped to the lifetime of one Client's own http.Client rather than
// shared across processes or tokens: GitHub folds the Authorization
// header into its own ETag calculation, so a cache entry from one token
// is never valid for a different one — a problem only for something
// that reuses a cache across rotating credentials (a GitHub App
// installation token, say). That never happens here: a Client holds
// exactly one token for its whole lifetime, so every cached entry was
// always made with the same Authorization header any later request on
// the same Client will send.
type etagTransport struct {
	base http.RoundTripper

	mu    sync.Mutex
	cache map[string]cachedResponse
}

type cachedResponse struct {
	etag   string
	body   []byte
	header http.Header
}

func newETagTransport(base http.RoundTripper) *etagTransport {
	if base == nil {
		base = http.DefaultTransport
	}
	return &etagTransport{base: base, cache: make(map[string]cachedResponse)}
}

// RoundTrip implements http.RoundTripper. Only a GET is ever cached — a
// write isn't safely retryable/cacheable, and GitHub's own conditional-
// request support is documented for GET/HEAD only.
func (t *etagTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		return t.base.RoundTrip(req)
	}

	key := req.URL.String()
	t.mu.Lock()
	cached, ok := t.cache[key]
	t.mu.Unlock()

	if ok {
		req = req.Clone(req.Context())
		req.Header.Set("If-None-Match", cached.etag)
	}

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, err
	}

	if ok && resp.StatusCode == http.StatusNotModified {
		return t.servedFromCache(resp, cached), nil
	}

	if resp.StatusCode == http.StatusOK {
		t.maybeCache(key, resp)
	}

	return resp, nil
}

// servedFromCache builds a synthetic 200 response from cached's own body
// and headers (a 304 carries neither) — fresh's own headers win where both
// set the same key, since those (rate-limit, request-id) reflect this
// exact request, not the one that originally populated the cache.
func (t *etagTransport) servedFromCache(fresh *http.Response, cached cachedResponse) *http.Response {
	_ = fresh.Body.Close()

	header := cached.header.Clone()
	for k, v := range fresh.Header {
		header[k] = v
	}

	return &http.Response{
		Status:        "200 OK",
		StatusCode:    http.StatusOK,
		Proto:         fresh.Proto,
		ProtoMajor:    fresh.ProtoMajor,
		ProtoMinor:    fresh.ProtoMinor,
		Header:        header,
		Body:          io.NopCloser(bytes.NewReader(cached.body)),
		ContentLength: int64(len(cached.body)),
		Request:       fresh.Request,
	}
}

// maybeCache stores resp's body under key, keyed off its own ETag — never
// touched again once read, since a caller downstream still needs the
// original response body intact.
func (t *etagTransport) maybeCache(key string, resp *http.Response) {
	etag := resp.Header.Get("ETag")
	if etag == "" {
		return
	}
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return
	}
	resp.Body = io.NopCloser(bytes.NewReader(body))

	t.mu.Lock()
	t.cache[key] = cachedResponse{etag: etag, body: body, header: resp.Header.Clone()}
	t.mu.Unlock()
}
