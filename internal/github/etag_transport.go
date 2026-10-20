package github

import (
	"bytes"
	"fmt"
	"io"
	"maps"
	"net/http"
	"sync"
)

// etagTransport wraps another http.RoundTripper with a per-URL ETag cache
// for GET requests — GitHub doesn't charge a 304 response against the
// REST rate limit, unlike a full 200, so a repeat call for data that
// hasn't changed (checkWebhooks' own ListHooks call runs once per
// tracked repo on every poll) can come back free instead (#381).
//
// Entries live in an etagStore and are keyed by forge, credential label
// and URL, never by Client or user: GitHub folds the Authorization header
// into its own ETag calculation, so an entry made under one credential is
// never offered under another. Two Clients holding the same credential
// share entries, so rebuilding a Client keeps the answers that are still
// good. The label is the one the API counters use (apistats.Credential*),
// so it holds no secret and no user id.
//
// #620: an App-mode Client's effective Authorization value does rotate
// roughly hourly under the hood (ghinstallation's own installation-token
// refresh). The label is the installation id, so entries survive that, and
// the first request after a rotation may be answered with a 200 instead
// of a 304, which is harmless: a miss, not a wrong answer.
type etagTransport struct {
	// base is what the cache calls; raw is the transport it started with, so
	// wrapBase can be called again without stacking wrappers.
	base http.RoundTripper
	raw  http.RoundTripper

	store      *etagStore
	credential string
}

// etagStore holds cached responses for every Client in the process.
type etagStore struct {
	mu      sync.Mutex
	entries map[etagKey]cachedResponse
}

type etagKey struct {
	forge      string
	credential string
	url        string
}

// maxETagEntries bounds the store. Past it an arbitrary entry is dropped,
// which only costs one full response later.
const maxETagEntries = 5000

func (s *etagStore) get(k etagKey) (cachedResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.entries[k]

	return v, ok
}

func (s *etagStore) put(k etagKey, v cachedResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.entries == nil {
		s.entries = make(map[etagKey]cachedResponse)
	}
	if _, exists := s.entries[k]; !exists && len(s.entries) >= maxETagEntries {
		for old := range s.entries {
			delete(s.entries, old)

			break
		}
	}
	s.entries[k] = v
}

// sharedETags is the process-wide store every Client uses.
var sharedETags = &etagStore{}

type cachedResponse struct {
	etag   string
	body   []byte
	header http.Header
}

// defaultTransport is a copy of http.DefaultTransport, so its connection pool
// belongs to one client.
func defaultTransport() http.RoundTripper {
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		return t.Clone()
	}

	return http.DefaultTransport
}

func newETagTransport(base http.RoundTripper, credential string) *etagTransport {
	if base == nil {
		// A transport of its own, not the process-wide default: every
		// httptest.Server.Close() calls CloseIdleConnections on the default
		// and cuts another client's connection mid-request (#1044).
		base = defaultTransport()
	}

	return &etagTransport{base: base, raw: base, store: sharedETags, credential: credential}
}

// wrapBase puts wrap between the cache and the network, below the cache so a
// wrapper sees the real 304 and not the 200 the cache turns it into. Call it
// before the transport carries traffic: base is read without a lock.
func (t *etagTransport) wrapBase(wrap func(http.RoundTripper) http.RoundTripper) {
	t.base = wrap(t.raw)
}

// RoundTrip implements http.RoundTripper. Only a GET is ever cached — a
// write isn't safely retryable/cacheable, and GitHub's own conditional-
// request support is documented for GET/HEAD only.
func (t *etagTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		resp, err := t.base.RoundTrip(req)
		if err != nil {
			return nil, fmt.Errorf("github: round trip: %w", err)
		}

		return resp, nil
	}

	key := etagKey{forge: "github", credential: t.credential, url: req.URL.String()}
	cached, ok := t.store.get(key)

	if ok {
		req = req.Clone(req.Context())
		req.Header.Set("If-None-Match", cached.etag)
	}

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("github: round trip: %w", err)
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
	maps.Copy(header, fresh.Header)

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
func (t *etagTransport) maybeCache(key etagKey, resp *http.Response) {
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

	t.store.put(key, cachedResponse{etag: etag, body: body, header: resp.Header.Clone()})
}
