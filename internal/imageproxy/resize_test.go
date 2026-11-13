package imageproxy_test

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	imgpng "image/png"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// noisy is a picture that does not compress to nothing, so a smaller size is
// a real saving.
func noisy(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			n := uint32(x*73856093) ^ uint32(y*19349663)
			n ^= n >> 13
			n *= 0x5bd1e995
			img.Set(x, y, color.RGBA{uint8(n & 0xff), uint8(n >> 8 & 0xff), uint8(n >> 16 & 0xff), 255})
		}
	}

	return img
}

func encodePNG(t *testing.T, img image.Image) imageproxy.Image {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, imgpng.Encode(&b, img))

	return imageproxy.Image{ContentType: "image/png", Data: b.Bytes()}
}

func encodeJPEG(t *testing.T, img image.Image) imageproxy.Image {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, img, &jpeg.Options{Quality: 90}))

	return imageproxy.Image{ContentType: "image/jpeg", Data: b.Bytes()}
}

func dims(t *testing.T, img imageproxy.Image) (int, int) {
	t.Helper()
	cfg, _, err := image.DecodeConfig(bytes.NewReader(img.Data))
	require.NoError(t, err)

	return cfg.Width, cfg.Height
}

func TestResize_ShrinksAPNGKeepingTheAspectRatio(t *testing.T) {
	t.Parallel()
	src := encodePNG(t, noisy(1600, 800))

	out, err := imageproxy.Resize(src, 640)

	require.NoError(t, err)
	assert.Equal(t, "image/png", out.ContentType)
	w, h := dims(t, out)
	assert.Equal(t, 640, w)
	assert.Equal(t, 320, h)
	assert.Less(t, len(out.Data), len(src.Data))
}

func TestResize_ShrinksAJPEGAndStaysAJPEG(t *testing.T) {
	t.Parallel()
	src := encodeJPEG(t, noisy(1200, 900))

	out, err := imageproxy.Resize(src, 320)

	require.NoError(t, err)
	assert.Equal(t, "image/jpeg", out.ContentType)
	w, h := dims(t, out)
	assert.Equal(t, 320, w)
	assert.Equal(t, 240, h)
	assert.Less(t, len(out.Data), len(src.Data))
}

func TestResize_ReturnsTheOriginalWhenNotWiderThanRequested(t *testing.T) {
	t.Parallel()
	src := encodePNG(t, noisy(300, 200))

	for _, width := range []int{300, 320, 640} {
		out, err := imageproxy.Resize(src, width)

		require.NoError(t, err)
		assert.Equal(t, src, out, "width %d", width)
	}
}

func TestResize_ReturnsTheOriginalForAGIF(t *testing.T) {
	t.Parallel()
	pal := []color.Color{color.Black, color.White}
	frame := func() *image.Paletted { return image.NewPaletted(image.Rect(0, 0, 900, 900), pal) }
	var b bytes.Buffer
	require.NoError(t, gif.EncodeAll(&b, &gif.GIF{Image: []*image.Paletted{frame(), frame()}, Delay: []int{5, 5}}))
	src := imageproxy.Image{ContentType: "image/gif", Data: b.Bytes()}

	out, err := imageproxy.Resize(src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_FallsBackToTheOriginalWhenDecodingFails(t *testing.T) {
	t.Parallel()
	good := encodePNG(t, noisy(1000, 1000))
	// Valid header (so the size check passes), truncated body.
	broken := imageproxy.Image{ContentType: "image/png", Data: good.Data[:len(good.Data)/2]}

	out, err := imageproxy.Resize(broken, 320)

	require.NoError(t, err)
	assert.Equal(t, broken, out)
}

func TestResize_FallsBackForAWebPItCannotDecode(t *testing.T) {
	t.Parallel()
	// RIFF/WEBP magic with nothing valid after it, as an animated file looks to
	// a still decoder.
	src := imageproxy.Image{ContentType: "image/webp", Data: append([]byte("RIFF\x20\x00\x00\x00WEBPVP8X"), make([]byte, 40)...)}

	out, err := imageproxy.Resize(src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_RefusesAnImageOverThePixelLimitBeforeDecoding(t *testing.T) {
	t.Parallel()
	// A PNG header declaring 40000x40000 followed by nothing: if Resize tried
	// to decode it, the fallback would hide it, so the refusal proves the
	// dimensions were read from the header alone.
	var b bytes.Buffer
	b.Write([]byte("\x89PNG\r\n\x1a\n"))
	b.Write([]byte{0, 0, 0, 13})
	hdr := []byte("IHDR\x00\x00\x9c\x40\x00\x00\x9c\x40\x08\x02\x00\x00\x00")
	b.Write(hdr)
	crc := pngCRC(hdr)
	b.Write(crc)
	src := imageproxy.Image{ContentType: "image/png", Data: b.Bytes()}

	_, err := imageproxy.Resize(src, 320)

	require.ErrorIs(t, err, imageproxy.ErrTooLarge)
}

func TestResize_AcceptsAnImageAtThePixelLimit(t *testing.T) {
	t.Parallel()
	// 4000x4000 is 16 MP, well inside the limit.
	src := encodePNG(t, image.NewGray(image.Rect(0, 0, 4000, 4000)))

	out, err := imageproxy.Resize(src, 320)

	require.NoError(t, err)
	w, _ := dims(t, out)
	assert.Equal(t, 320, w)
}

func TestAllowedWidth(t *testing.T) {
	t.Parallel()
	for _, w := range []int{320, 640, 960, 1280} {
		assert.True(t, imageproxy.AllowedWidth(w), w)
	}
	for _, w := range []int{-1, 0, 1, 321, 641, 100000} {
		assert.False(t, imageproxy.AllowedWidth(w), w)
	}
}

func pngCRC(chunk []byte) []byte {
	c := crc32.ChecksumIEEE(chunk)

	return binary.BigEndian.AppendUint32(nil, c)
}

func TestResize_KeepsTheOriginalWhenScalingWouldNotMakeItSmaller(t *testing.T) {
	t.Parallel()
	// A heavily compressed JPEG, only a little wider than the target: the
	// re-encode at the proxy's quality is bigger, so the original wins.
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, noisy(1000, 1000), &jpeg.Options{Quality: 1}))
	src := imageproxy.Image{ContentType: "image/jpeg", Data: b.Bytes()}

	out, err := imageproxy.Resize(src, 960)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}
