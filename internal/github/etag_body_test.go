package github_test

import (
	"io"
	"net/http"
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
