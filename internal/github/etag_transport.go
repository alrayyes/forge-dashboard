package github

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"maps"
	"net/http"
)

// etagTransport wraps another http.RoundTripper with a per-URL ETag cache
// for GET requests — GitHub doesn't charge a 304 response against the
// REST rate limit, unlike a full 200, so a repeat call for data that
// hasn't changed (checkWebhooks' own ListHooks call runs once per
// tracked repo on every poll) can come back free instead (#381).
//
// Entries live in an etagStore and are keyed by forge, credential label,
// URL and Accept header (GitHub varies the body on it), never by Client or
// user: GitHub folds the Authorization header
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

	key := etagKey{forge: "github", credential: t.credential, url: req.URL.String(), accept: req.Header.Get("Accept")}
	cached, ok := t.store.get(req.Context(), key)

	if ok {
		req = req.Clone(req.Context())
		req.Header.Set("If-None-Match", cached.etag)
	}

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		return nil, fmt.Errorf("github: round trip: %w", err)
	}

	if ok && resp.StatusCode == http.StatusNotModified {
		t.store.used(req.Context(), key)
		return t.servedFromCache(resp, cached), nil
	}

	if resp.StatusCode == http.StatusOK {
		t.maybeCache(req.Context(), key, resp)
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

// spliceBody reads from Reader and closes closer, so a body that was read
// ahead and the unread rest of it behave as the one body they were.
type spliceBody struct {
	io.Reader
	closer io.Closer
}

func (b *spliceBody) Close() error {
	if err := b.closer.Close(); err != nil {
		return fmt.Errorf("github: close response body: %w", err)
	}

	return nil
}

// errReader fails every read with its error.
type errReader struct{ err error }

func (r errReader) Read([]byte) (int, error) { return 0, r.err }

// maybeCache stores resp's body under key, keyed off its own ETag — never
// touched again once read, since a caller downstream still needs the
// original response body intact.
func (t *etagTransport) maybeCache(ctx context.Context, key etagKey, resp *http.Response) {
	etag := resp.Header.Get("ETag")
	if etag == "" {
		return
	}
	// Read at most one byte past the cap: that is enough to know the body is
	// too big, without holding all of it just to throw the copy away.
	original := resp.Body
	body, err := io.ReadAll(io.LimitReader(original, maxETagBodyBytes+1))
	if err != nil {
		// Not cached. The caller gets what was read, then the same error,
		// whether or not the original body would repeat it on another read.
		resp.Body = &spliceBody{Reader: io.MultiReader(bytes.NewReader(body), errReader{err}), closer: original}

		return
	}
	if len(body) > maxETagBodyBytes {
		// Not cached. The caller still gets the whole body: what was read,
		// then the rest.
		resp.Body = &spliceBody{Reader: io.MultiReader(bytes.NewReader(body), original), closer: original}

		return
	}
	_ = original.Close()
	resp.Body = io.NopCloser(bytes.NewReader(body))
	t.store.put(ctx, key, cachedResponse{etag: etag, body: body, header: resp.Header.Clone()})
}
