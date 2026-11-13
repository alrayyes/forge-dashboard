package api_test

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// widePNG is a noisy picture 1600 pixels wide, so a resize is a real saving.
func widePNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1600, 800))
	for y := range 800 {
		for x := range 1600 {
			n := uint32(x*73856093) ^ uint32(y*19349663)
			n ^= n >> 13
			n *= 0x5bd1e995
			img.Set(x, y, color.RGBA{uint8(n & 0xff), uint8(n >> 8 & 0xff), uint8(n >> 16 & 0xff), 255})
		}
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))

	return b.Bytes()
}

func getImageWidth(t *testing.T, srv string, cookie *http.Cookie, raw, width string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {"forgejo"}, "url": {raw}, "width": {width}}
	req, err := http.NewRequest(http.MethodGet, srv+"/api/v1/images?"+q.Encode(), nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func bigImageForge(t *testing.T) (*httptest.Server, []byte, *atomic.Int32) {
	t.Helper()
	body := widePNG(t)
	hits := &atomic.Int32{}
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(body)
	}))
	t.Cleanup(forge.Close)

	return forge, body, hits
}

func TestImages_WidthScalesTheImageDown(t *testing.T) {
	t.Parallel()
	forge, original, _ := bigImageForge(t)
	srv, cookie := imagesServer(t, forge)

	resp := getImageWidth(t, srv, cookie, forge.URL+"/a/big", "640")
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(got))
	require.NoError(t, err)
	assert.Equal(t, 640, cfg.Width)
	assert.Equal(t, 320, cfg.Height)
	assert.Less(t, len(got), len(original))
	assert.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
}

func TestImages_NoWidthReturnsTheOriginalBytes(t *testing.T) {
	t.Parallel()
	forge, original, _ := bigImageForge(t)
	srv, cookie := imagesServer(t, forge)

	resp := getImage(t, srv, cookie, "forgejo", forge.URL+"/a/big")
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, original, got)
}

func TestImages_AWidthOutsideTheAllowedSetIsABadRequest(t *testing.T) {
	t.Parallel()
	forge, _, hits := bigImageForge(t)
	srv, cookie := imagesServer(t, forge)

	for _, w := range []string{"0", "-5", "321", "abc", "99999999999", "640.5", ""} {
		resp := getImageWidth(t, srv, cookie, forge.URL+"/a/big", w)
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusBadRequest, resp.StatusCode, "width %q", w)
	}
	assert.Zero(t, hits.Load(), "a bad width must not cost an upstream fetch")
}

func TestImages_AFetchedOriginalSmallerThanTheWidthIsReturnedUnchanged(t *testing.T) {
	t.Parallel()
	forge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(imagesPNG)
	}))
	t.Cleanup(forge.Close)
	srv, cookie := imagesServer(t, forge)

	resp := getImageWidth(t, srv, cookie, forge.URL+"/a/tiny", "640")
	defer func() { _ = resp.Body.Close() }()
	got, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, imagesPNG, got)
}

func TestImages_WidthAndNoWidthAreCachedSeparately(t *testing.T) {
	t.Parallel()
	forge, original, _ := bigImageForge(t)
	srv, cookie := imagesServer(t, forge)

	small := getImageWidth(t, srv, cookie, forge.URL+"/a/big", "320")
	smallBody, _ := io.ReadAll(small.Body)
	_ = small.Body.Close()
	full := getImage(t, srv, cookie, "forgejo", forge.URL+"/a/big")
	fullBody, _ := io.ReadAll(full.Body)
	_ = full.Body.Close()

	assert.Less(t, len(smallBody), len(fullBody), "a cached thumbnail must not answer for the full image")
	assert.Equal(t, original, fullBody)
}
