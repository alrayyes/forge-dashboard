package imageproxy

import (
	"bytes"
	"context"
	"fmt"
	"image"
	_ "image/gif" // registers GIF so DecodeConfig can read its header
	"image/jpeg"
	"image/png"
	"slices"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registers WebP, which the proxy accepts
)

// MaxPixels is the most a source may hold before the proxy refuses to resize
// it, read from the header before anything is allocated. Decoding costs up to
// about ten bytes a pixel (a 16-bit PNG measured 232 MB at 24 million pixels),
// so one resize stays near 160 MB at this limit.
const MaxPixels = 16_000_000

// maxConcurrentResizes bounds how many decodes are in memory at once, below the
// fetch concurrency, so the worst case is a few hundred megabytes, not the
// product of every fetch slot and the largest image.
const maxConcurrentResizes = 2

var resizeSlots = make(chan struct{}, maxConcurrentResizes)

const jpegQuality = 85

// widths are the sizes a caller may ask for, so the cache and the CPU cost
// stay bounded by a short list rather than by whatever number arrives.
var widths = []int{320, 640, 960, 1280}

// AllowedWidth reports whether width is one of the sizes Resize is offered.
func AllowedWidth(width int) bool { return slices.Contains(widths, width) }

// Resize returns img scaled down to width pixels wide, keeping the aspect
// ratio. The original comes back unchanged when it is no wider than width,
// when it is a GIF (which may be animated, and a still frame would lose that),
// when it cannot be decoded, when it is a JPEG, PNG or WebP with an EXIF
// orientation other than upright, or a PNG or WebP whose orientation metadata
// can't be read (scaling would drop the tag and turn the picture; a JPEG with
// an unreadable tag counts as untagged), or when the result would not be
// smaller. A source over MaxPixels is refused with ErrTooLarge, judged from
// its header alone.
// Waiting for one of the few resize slots ends with ctx.
func Resize(ctx context.Context, img Image, width int) (Image, error) {
	if img.ContentType == "image/gif" {
		return img, nil
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(img.Data))
	if err != nil {
		return img, nil //nolint:nilerr // not an image we can read: pass it on as before
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > MaxPixels/cfg.Height {
		return Image{}, ErrTooLarge
	}
	if cfg.Width <= width {
		return img, nil
	}
	if o := orientation(img); o > 1 || o == unreadable {
		return img, nil
	}
	select {
	case resizeSlots <- struct{}{}:
		defer func() { <-resizeSlots }()
	case <-ctx.Done():
		return Image{}, fmt.Errorf("imageproxy: %w", ctx.Err())
	}
	src, _, err := image.Decode(bytes.NewReader(img.Data))
	if err != nil {
		return img, nil //nolint:nilerr // truncated or unsupported (animated WebP): pass it on
	}
	height := max(1, int(int64(cfg.Height)*int64(width)/int64(cfg.Width)))
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)

	var buf bytes.Buffer
	out := Image{}
	if img.ContentType == "image/jpeg" {
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: jpegQuality})
		out.ContentType = "image/jpeg"
	} else {
		// PNG, and WebP, which the standard library cannot write.
		err = png.Encode(&buf, dst)
		out.ContentType = "image/png"
	}
	if err != nil || buf.Len() >= len(img.Data) {
		return img, nil //nolint:nilerr // the original is already the smaller one
	}
	out.Data = buf.Bytes()

	return out, nil
}
