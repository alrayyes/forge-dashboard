package imageproxy_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	imgpng "image/png"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/image/draw"
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

	out, err := imageproxy.Resize(t.Context(), src, 640)

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

	out, err := imageproxy.Resize(t.Context(), src, 320)

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
		out, err := imageproxy.Resize(t.Context(), src, width)

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

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_FallsBackToTheOriginalWhenDecodingFails(t *testing.T) {
	t.Parallel()
	good := encodePNG(t, noisy(1000, 1000))
	// Valid header (so the size check passes), truncated body.
	broken := imageproxy.Image{ContentType: "image/png", Data: good.Data[:len(good.Data)/2]}

	out, err := imageproxy.Resize(t.Context(), broken, 320)

	require.NoError(t, err)
	assert.Equal(t, broken, out)
}

func TestResize_FallsBackForAWebPItCannotDecode(t *testing.T) {
	t.Parallel()
	// RIFF/WEBP magic with nothing valid after it, as an animated file looks to
	// a still decoder.
	src := imageproxy.Image{ContentType: "image/webp", Data: append([]byte("RIFF\x20\x00\x00\x00WEBPVP8X"), make([]byte, 40)...)}

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_RefusesAnImageOverThePixelLimitBeforeDecoding(t *testing.T) {
	t.Parallel()
	// A PNG header declaring 40000x40000 followed by nothing: if Resize tried
	// to decode it, the fallback would hide it, so the refusal proves the
	// dimensions were read from the header alone.
	src := headerOnlyPNG(40000, 40000)

	_, err := imageproxy.Resize(t.Context(), src, 320)

	require.ErrorIs(t, err, imageproxy.ErrTooLarge)
}

func TestAllowedWidth(t *testing.T) {
	t.Parallel()
	for _, w := range []int{320, 640, 960, 1280} {
		assert.True(t, imageproxy.AllowedWidth(w), w)
	}
	for _, w := range []int{-1, 0, 1, 160, 321, 480, 641, 1920, 2560, 100000} {
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

	out, err := imageproxy.Resize(t.Context(), src, 960)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

// headerOnlyPNG is a PNG signature and IHDR declaring w by h and nothing
// after, so a decode would fail and only the header can have been judged.
func headerOnlyPNG(w, h uint32) imageproxy.Image {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	b.Write([]byte{0, 0, 0, 13})
	hdr := []byte("IHDR")
	hdr = binary.BigEndian.AppendUint32(hdr, w)
	hdr = binary.BigEndian.AppendUint32(hdr, h)
	hdr = append(hdr, 8, 2, 0, 0, 0)
	b.Write(hdr)
	b.Write(pngCRC(hdr))

	return imageproxy.Image{ContentType: "image/png", Data: b.Bytes()}
}

func TestResize_PixelLimitBoundary(t *testing.T) {
	t.Parallel()
	require.Equal(t, 16_000_000, imageproxy.MaxPixels)

	atLimit, err := imageproxy.Resize(t.Context(), headerOnlyPNG(4000, 4000), 320)
	require.NoError(t, err, "exactly MaxPixels is accepted")
	assert.NotEmpty(t, atLimit.Data)
	_, err = imageproxy.Resize(t.Context(), headerOnlyPNG(16_000_000, 1), 320)
	require.NoError(t, err, "a wide, short image at the limit is accepted")

	_, err = imageproxy.Resize(t.Context(), headerOnlyPNG(16_000_001, 1), 320)
	require.ErrorIs(t, err, imageproxy.ErrTooLarge, "one pixel over is refused")
	_, err = imageproxy.Resize(t.Context(), headerOnlyPNG(4001, 4000), 320)
	require.ErrorIs(t, err, imageproxy.ErrTooLarge)
	_, err = imageproxy.Resize(t.Context(), headerOnlyPNG(1, 16_000_001), 320)
	require.ErrorIs(t, err, imageproxy.ErrTooLarge)
}

func TestResize_AZeroSizedHeaderIsPassedOnNotRefusedOrCrashed(t *testing.T) {
	t.Parallel()
	src := headerOnlyPNG(0, 0)

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_NeverUpscales(t *testing.T) {
	t.Parallel()
	src := encodePNG(t, noisy(200, 100))

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func TestResize_AVeryWideImageKeepsAtLeastOnePixelOfHeight(t *testing.T) {
	t.Parallel()
	src := encodePNG(t, noisy(2000, 1))

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	w, h := dims(t, out)
	assert.Equal(t, 320, w)
	assert.Equal(t, 1, h)
}

func TestResize_AveragesInsteadOfPickingPixels(t *testing.T) {
	t.Parallel()
	// A one-pixel checkerboard four times too wide. Nearest neighbour keeps
	// pure black or white; a real kernel lands on grey.
	img := image.NewGray(image.Rect(0, 0, 1280, 1280))
	for y := range 1280 {
		for x := range 1280 {
			if (x+y)%2 == 0 {
				img.SetGray(x, y, color.Gray{Y: 255})
			}
		}
	}
	src := encodePNG(t, img)

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	got, err := imgpng.Decode(bytes.NewReader(out.Data))
	require.NoError(t, err)
	r, _, _, _ := got.At(100, 100).RGBA()
	grey := r >> 8
	assert.Greater(t, grey, uint32(90))
	assert.Less(t, grey, uint32(165))
}

// withOrientation inserts an EXIF APP1 segment holding one orientation tag
// right after the JPEG's start marker.
func withOrientation(t *testing.T, jpg imageproxy.Image, orientation uint16) imageproxy.Image {
	t.Helper()
	exif := []byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x01\x01\x12\x00\x03\x00\x00\x00\x01")
	exif = binary.BigEndian.AppendUint16(exif, orientation)
	exif = append(exif, 0, 0, 0, 0, 0, 0)
	seg := []byte{0xFF, 0xE1}
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(exif)+2)) //nolint:gosec // a few bytes
	seg = append(seg, exif...)
	data := append([]byte{}, jpg.Data[:2]...)
	data = append(data, seg...)
	data = append(data, jpg.Data[2:]...)

	return imageproxy.Image{ContentType: "image/jpeg", Data: data}
}

func TestResize_ReturnsTheOriginalForARotatedJPEG(t *testing.T) {
	t.Parallel()
	plain := encodeJPEG(t, noisy(1200, 900))

	for _, o := range []uint16{2, 3, 6, 8} {
		src := withOrientation(t, plain, o)
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err)
		assert.Equal(t, src, out, "orientation %d", o)
	}
}

func TestResize_ScalesAnUprightJPEGEvenWithAnEXIFTag(t *testing.T) {
	t.Parallel()
	src := withOrientation(t, encodeJPEG(t, noisy(1200, 900)), 1)

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	w, _ := dims(t, out)
	assert.Equal(t, 320, w)
}

func TestResize_AnImageExactlyTheRequestedWidthIsNotRescaled(t *testing.T) {
	t.Parallel()
	// Re-encoding this at the proxy's quality would be smaller, so only the
	// width comparison keeps it as it was.
	var b bytes.Buffer
	require.NoError(t, jpeg.Encode(&b, noisy(320, 240), &jpeg.Options{Quality: 100}))
	src := imageproxy.Image{ContentType: "image/jpeg", Data: b.Bytes()}

	out, err := imageproxy.Resize(t.Context(), src, 320)

	require.NoError(t, err)
	assert.Equal(t, src, out)
}

func insertAfterSOI(jpg imageproxy.Image, seg []byte) imageproxy.Image {
	data := append([]byte{}, jpg.Data[:2]...)
	data = append(data, seg...)
	data = append(data, jpg.Data[2:]...)

	return imageproxy.Image{ContentType: "image/jpeg", Data: data}
}

func segment(marker byte, body []byte) []byte {
	seg := []byte{0xFF, marker}
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(body)+2)) //nolint:gosec // a few bytes

	return append(seg, body...)
}

func TestResize_FindsTheOrientationBehindOtherMarkerSegments(t *testing.T) {
	t.Parallel()
	rotated := withOrientation(t, encodeJPEG(t, noisy(1200, 900)), 6)
	jfif := segment(0xE0, []byte("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"))
	xmp := segment(0xE1, []byte("http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta/>"))

	for name, src := range map[string]imageproxy.Image{
		"after JFIF":       insertAfterSOI(rotated, jfif),
		"after XMP":        insertAfterSOI(rotated, xmp),
		"after both":       insertAfterSOI(insertAfterSOI(rotated, xmp), jfif),
		"little endian II": insertAfterSOI(encodeJPEG(t, noisy(1200, 900)), littleEndianOrientation(8)),
	} {
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err, name)
		assert.Equal(t, src, out, name)
	}
}

func littleEndianOrientation(o byte) []byte {
	exif := []byte("Exif\x00\x00II\x2a\x00\x08\x00\x00\x00\x01\x00\x12\x01\x03\x00\x01\x00\x00\x00")
	exif = append(exif, o, 0, 0, 0, 0, 0, 0, 0)

	return segment(0xE1, exif)
}

// Not parallel: it holds the shared resize slots, which would starve or
// deadlock a parallel test holding them too.
func TestResize_OnlyTwoRunAtOnceAndAWaitingOneEndsWithItsContext(t *testing.T) {
	src := encodePNG(t, noisy(1000, 800))
	require.Equal(t, 2, imageproxy.ResizeSlots, "the documented limit")

	t.Run("one free slot lets a resize through", func(t *testing.T) {
		release := imageproxy.HoldResizeSlots(1)
		defer release()

		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err)
		w, _ := dims(t, out)
		assert.Equal(t, 320, w)
	})

	t.Run("no free slot blocks until the context ends", func(t *testing.T) {
		release := imageproxy.HoldResizeSlots(2)
		ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
		defer cancel()
		start := time.Now()

		errc := make(chan error, 1)
		go func() {
			_, err := imageproxy.Resize(ctx, src, 320)
			errc <- err
		}()
		var err error
		select {
		case err = <-errc:
		case <-time.After(5 * time.Second):
			t.Fatal("the wait for a slot ignored its context")
		}

		require.ErrorIs(t, err, context.DeadlineExceeded)
		assert.GreaterOrEqual(t, time.Since(start), 90*time.Millisecond, "it waited for a slot")
		assert.Less(t, time.Since(start), 2*time.Second, "it stopped when the context did")
		release()
	})

	t.Run("a cancelled context stops the wait at once", func(t *testing.T) {
		release := imageproxy.HoldResizeSlots(2)
		defer release()
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		errc := make(chan error, 1)
		go func() {
			_, err := imageproxy.Resize(ctx, src, 320)
			errc <- err
		}()
		var err error
		select {
		case err = <-errc:
		case <-time.After(5 * time.Second):
			t.Fatal("the wait for a slot ignored its context")
		}

		require.ErrorIs(t, err, context.Canceled)
	})
}

// Not parallel: it holds the shared resize slots, which would starve or
// deadlock a parallel test holding them too.
func TestResize_ASlotFreedLetsTheWaitingResizeFinish(t *testing.T) {
	src := encodePNG(t, noisy(1000, 800))
	release := imageproxy.HoldResizeSlots(2)
	done := make(chan error, 1)
	go func() {
		_, err := imageproxy.Resize(t.Context(), src, 320)
		done <- err
	}()

	select {
	case err := <-done:
		t.Fatalf("a resize ran with every slot held (err %v)", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()

	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("the waiting resize never ran after a slot freed")
	}
}

func TestResize_EncodesAJPEGAtQuality85(t *testing.T) {
	t.Parallel()
	// A smooth picture with some texture, so the quality setting shows in the
	// size. The expected bytes are the same scale and encode done here.
	img := image.NewRGBA(image.Rect(0, 0, 1280, 960))
	for y := range 960 {
		for x := range 1280 {
			img.Set(x, y, color.RGBA{uint8(x / 5), uint8(y / 4), uint8((x * y) >> 7 & 0xff), 255})
		}
	}
	src := encodeJPEG(t, img)
	ref := image.NewRGBA(image.Rect(0, 0, 640, 480))
	draw.CatmullRom.Scale(ref, ref.Bounds(), decodeJPEG(t, src), img.Bounds(), draw.Src, nil)
	var want bytes.Buffer
	require.NoError(t, jpeg.Encode(&want, ref, &jpeg.Options{Quality: 85}))

	out, err := imageproxy.Resize(t.Context(), src, 640)

	require.NoError(t, err)
	assert.Equal(t, want.Bytes(), out.Data)
}

func decodeJPEG(t *testing.T, img imageproxy.Image) image.Image {
	t.Helper()
	got, err := jpeg.Decode(bytes.NewReader(img.Data))
	require.NoError(t, err)

	return got
}
