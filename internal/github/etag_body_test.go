package github_test

import (
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// countingBody is a body of remaining bytes that counts what has been read.
type countingBody struct {
	remaining int
	read      *atomic.Int64
}

func (b *countingBody) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		return 0, io.EOF
	}
	n := min(len(p), b.remaining)
	for i := range p[:n] {
		p[i] = 'y'
	}
	b.remaining -= n
	b.read.Add(int64(n))

	return n, nil
}

func (b *countingBody) Close() error { return nil }

type bigBodyTransport struct {
	size int
	read atomic.Int64
}

func (r *bigBodyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Etag": {`"big"`}},
		Body:       &countingBody{remaining: r.size, read: &r.read},
		Request:    req,
	}, nil
}

func roundTripBig(t *testing.T, base http.RoundTripper, credential string) io.Reader {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://example.test/big", nil)
	require.NoError(t, err)
	resp, err := github.NewETagTransport(base, credential).RoundTrip(req)
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	return resp.Body
}

func TestETagCache_BodyOverTheCap_ReadsNoMoreThanTheCapAndOneBuffer(t *testing.T) {
	t.Parallel()

	base := &bigBodyTransport{size: 8 * github.MaxETagBodyBytes}
	roundTripBig(t, base, "bounded-read-token")

	const readBuffer = 64 << 10
	assert.LessOrEqual(t, base.read.Load(), int64(github.MaxETagBodyBytes+readBuffer))
}

func TestETagCache_BodyOverTheCap_CallerStillReadsTheWholeBody(t *testing.T) {
	t.Parallel()

	size := 3*github.MaxETagBodyBytes + 17
	body := roundTripBig(t, &bigBodyTransport{size: size}, "whole-body-token")

	got, err := io.ReadAll(body)
	require.NoError(t, err)
	assert.Len(t, got, size)
}

var errBoom = errors.New("connection reset")

// scriptedBody yields remaining bytes and then err (or EOF if err is nil).
// After its first error it returns EOF, like a body that does not repeat it.
type scriptedBody struct {
	remaining int
	err       error
	failed    bool
	closes    *atomic.Int64
}

func (b *scriptedBody) Read(p []byte) (int, error) {
	if b.remaining == 0 {
		if b.err != nil && !b.failed {
			b.failed = true

			return 0, b.err
		}

		return 0, io.EOF
	}
	n := min(len(p), b.remaining)
	for i := range p[:n] {
		p[i] = 'z'
	}
	b.remaining -= n

	return n, nil
}

func (b *scriptedBody) Close() error {
	b.closes.Add(1)

	return nil
}

// scriptedTransport answers 304 to a conditional request and otherwise a 200
// with an ETag and a scriptedBody. It records whether each request was
// conditional and how often the bodies it handed out were closed.
type scriptedTransport struct {
	size   int
	err    error
	mu     sync.Mutex
	sent   []bool
	closes atomic.Int64
}

func (r *scriptedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	conditional := req.Header.Get("If-None-Match") != ""
	r.mu.Lock()
	r.sent = append(r.sent, conditional)
	r.mu.Unlock()
	if conditional {
		return &http.Response{StatusCode: http.StatusNotModified, Header: http.Header{}, Body: http.NoBody, Request: req}, nil
	}

	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Etag": {`"v1"`}},
		Body:       &scriptedBody{remaining: r.size, err: r.err, closes: &r.closes},
		Request:    req,
	}, nil
}

// readTwice sends the same GET twice through one caching transport and returns
// what the caller read each time.
func readTwice(t *testing.T, base *scriptedTransport, credential string) (bodies [2][]byte, errs [2]error) {
	t.Helper()
	rt := github.NewETagTransport(base, credential)
	for i := range 2 {
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://example.test/scripted", nil)
		require.NoError(t, err)
		resp, err := rt.RoundTrip(req)
		require.NoError(t, err)
		bodies[i], errs[i] = io.ReadAll(resp.Body)
		_ = resp.Body.Close()
	}

	return bodies, errs
}

func TestETagCache_BodyAtTheCap_IsCachedAndWhole(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: github.MaxETagBodyBytes}
	bodies, _ := readTwice(t, base, "at-cap-token")

	assert.Equal(t, []bool{false, true}, base.sent, "the second request was conditional because the first was kept")
	assert.Len(t, bodies[0], github.MaxETagBodyBytes)
	assert.Len(t, bodies[1], github.MaxETagBodyBytes)
}

func TestETagCache_BodyOneOverTheCap_IsNotCachedButWhole(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: github.MaxETagBodyBytes + 1}
	bodies, _ := readTwice(t, base, "over-cap-token")

	assert.Equal(t, []bool{false, false}, base.sent)
	assert.Len(t, bodies[0], github.MaxETagBodyBytes+1)
	assert.Len(t, bodies[1], github.MaxETagBodyBytes+1)
}

func TestETagCache_ReadErrorMidBody_ReachesTheCaller(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: 100, err: errBoom}
	_, errs := readTwice(t, base, "read-error-token")

	assert.ErrorIs(t, errs[0], errBoom, "a body that does not repeat its error must not look complete")
}

func TestETagCache_ReadErrorMidBody_IsNeverStored(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: 100, err: errBoom}
	readTwice(t, base, "read-error-stored-token")

	assert.Equal(t, []bool{false, false}, base.sent)
}

func TestETagCache_OverTheCap_ClosesTheOriginalBodyOncePerRequest(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: github.MaxETagBodyBytes + 1}
	readTwice(t, base, "close-once-over-token")

	assert.Equal(t, int64(2), base.closes.Load())
}

func TestETagCache_UnderTheCap_ClosesTheOriginalBodyOnce(t *testing.T) {
	t.Parallel()

	base := &scriptedTransport{size: 100}
	readTwice(t, base, "close-once-under-token")

	assert.Equal(t, int64(1), base.closes.Load(), "the second request was a 304 with no body of its own")
}
