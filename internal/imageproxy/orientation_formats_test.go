package imageproxy_test

import (
	"encoding/binary"
	"os"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// tiffOrientation is a bare TIFF block holding one orientation tag, which is
// what a PNG eXIf chunk and a WebP EXIF chunk carry.
func tiffOrientation(o uint16, order binary.AppendByteOrder) []byte {
	var b []byte
	if order == binary.AppendByteOrder(binary.LittleEndian) {
		b = []byte("II")
	} else {
		b = []byte("MM")
	}
	b = order.AppendUint16(b, 42)
	b = order.AppendUint32(b, 8)
	b = order.AppendUint16(b, 1)
	b = order.AppendUint16(b, 0x0112)
	b = order.AppendUint16(b, 3)
	b = order.AppendUint32(b, 1)
	b = order.AppendUint16(b, o)
	b = append(b, 0, 0)

	return order.AppendUint32(b, 0)
}

// pngWithChunk adds a chunk right after IHDR, or before IEND when atEnd.
func pngWithChunk(t *testing.T, src imageproxy.Image, kind string, body []byte, atEnd bool) imageproxy.Image {
	t.Helper()
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(body))) //nolint:gosec // a few bytes
	chunk = append(chunk, kind...)
	chunk = append(chunk, body...)
	chunk = append(chunk, pngCRC(chunk[4:])...)
	at := 8 + 25
	if atEnd {
		at = len(src.Data) - 12
	}
	data := append([]byte{}, src.Data[:at]...)
	data = append(data, chunk...)
	data = append(data, src.Data[at:]...)

	return imageproxy.Image{ContentType: "image/png", Data: data}
}

func stillWebP(t *testing.T) imageproxy.Image {
	t.Helper()
	data, err := os.ReadFile("testdata/still.webp")
	require.NoError(t, err)

	return imageproxy.Image{ContentType: "image/webp", Data: data}
}

// webpWithExif turns a simple still WebP into an extended one with an EXIF
// chunk after the picture.
func webpWithExif(t *testing.T, still imageproxy.Image, exif []byte) imageproxy.Image {
	t.Helper()

	return webpWithChunks(t, still, nil, chunkRIFF("EXIF", exif))
}

// webpWithChunks builds an extended WebP from a simple still one: VP8X, then
// before, the picture, then after. Both are whole RIFF chunks.
func webpWithChunks(t *testing.T, still imageproxy.Image, before, after []byte) imageproxy.Image {
	t.Helper()
	require.Equal(t, "VP8 ", string(still.Data[12:16]))
	vp8 := still.Data[12:]
	cfg, h := dims(t, still)
	vp8x := []byte{0x08, 0, 0, 0}
	vp8x = append(vp8x, byte(cfg-1), byte((cfg-1)>>8), 0) //nolint:gosec // a few hundred pixels
	vp8x = append(vp8x, byte(h-1), byte((h-1)>>8), 0)     //nolint:gosec // a few hundred pixels
	body := []byte("WEBP")
	body = append(body, chunkRIFF("VP8X", vp8x)...)
	body = append(body, before...)
	body = append(body, vp8...)
	body = append(body, after...)
	data := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(body)))...) //nolint:gosec // small
	data = append(data, body...)

	return imageproxy.Image{ContentType: "image/webp", Data: data}
}

func chunkRIFF(kind string, body []byte) []byte {
	c := []byte(kind)
	c = binary.LittleEndian.AppendUint32(c, uint32(len(body))) //nolint:gosec // small
	c = append(c, body...)
	if len(body)%2 == 1 {
		c = append(c, 0)
	}

	return c
}

func TestResize_ReturnsTheOriginalForARotatedPNG(t *testing.T) {
	t.Parallel()
	plain := encodePNG(t, noisy(1200, 900))

	for _, o := range []uint16{2, 3, 6, 8} {
		for name, order := range map[string]binary.AppendByteOrder{"MM": binary.BigEndian, "II": binary.LittleEndian} {
			for place, atEnd := range map[string]bool{"after IHDR": false, "before IEND": true} {
				src := pngWithChunk(t, plain, "eXIf", tiffOrientation(o, order), atEnd)
				out, err := imageproxy.Resize(t.Context(), src, 320)

				require.NoError(t, err)
				assert.Equal(t, src, out, "orientation %d %s %s", o, name, place)
			}
		}
	}
}

func TestResize_ScalesAnUprightPNGOrOneWithoutOrientation(t *testing.T) {
	t.Parallel()
	plain := encodePNG(t, noisy(1200, 900))
	other := pngWithChunk(t, plain, "tEXt", []byte("Comment\x00hi"), false)

	for name, src := range map[string]imageproxy.Image{
		"upright":               pngWithChunk(t, plain, "eXIf", tiffOrientation(1, binary.BigEndian), false),
		"no tag":                plain,
		"other chunks":          other,
		"upright little endian": pngWithChunk(t, plain, "eXIf", tiffOrientation(1, binary.LittleEndian), false),
		"upright after IDAT":    pngWithChunk(t, plain, "eXIf", tiffOrientation(1, binary.LittleEndian), true),
		"tag value 0":           pngWithChunk(t, plain, "eXIf", tiffOrientation(0, binary.BigEndian), false),
		"rotated after IEND":    pngAfterIEND(plain, "eXIf", tiffOrientation(6, binary.BigEndian)),
		"no orientation tag": pngWithChunk(t, plain, "eXIf",
			[]byte("MM\x00\x2a\x00\x00\x00\x08\x00\x00\x00\x00\x00\x00"), false),
	} {
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err, name)
		w, _ := dims(t, out)
		assert.Equal(t, 320, w, name)
	}
}

func TestResize_ReturnsTheOriginalForARotatedWebP(t *testing.T) {
	t.Parallel()
	still := stillWebP(t)

	for _, o := range []uint16{2, 3, 6, 8} {
		for name, exif := range map[string][]byte{
			"MM":          tiffOrientation(o, binary.BigEndian),
			"II":          tiffOrientation(o, binary.LittleEndian),
			"Exif prefix": append([]byte("Exif\x00\x00"), tiffOrientation(o, binary.BigEndian)...),
		} {
			src := webpWithExif(t, still, exif)
			out, err := imageproxy.Resize(t.Context(), src, 320)

			require.NoError(t, err)
			assert.Equal(t, src, out, "orientation %d %s", o, name)
		}
	}
}

func TestResize_ReturnsTheOriginalForAnOutOfRangeTag(t *testing.T) {
	t.Parallel()
	plain := encodePNG(t, noisy(1200, 900))
	still := stillWebP(t)

	for _, o := range []uint16{9, 255, 0xffff} {
		for name, src := range map[string]imageproxy.Image{
			"png":  pngWithChunk(t, plain, "eXIf", tiffOrientation(o, binary.BigEndian), false),
			"webp": webpWithExif(t, still, tiffOrientation(o, binary.LittleEndian)),
		} {
			out, err := imageproxy.Resize(t.Context(), src, 320)

			require.NoError(t, err)
			assert.Equal(t, src, out, "%s tag %d", name, o)
		}
	}
}

func TestResize_FindsAWebPOrientationBehindOtherChunks(t *testing.T) {
	t.Parallel()
	still := stillWebP(t)
	rotated := chunkRIFF("EXIF", tiffOrientation(6, binary.BigEndian))

	for name, src := range map[string]imageproxy.Image{
		"odd chunk first":    webpWithChunks(t, still, chunkRIFF("ICCP", []byte("abc")), rotated),
		"name inside a body": webpWithChunks(t, still, chunkRIFF("ICCP", []byte("EXIF!!")), rotated),
		"XMP first":          webpWithChunks(t, still, chunkRIFF("XMP ", []byte("<x/>")), rotated),
	} {
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err, name)
		assert.Equal(t, src, out, name)
	}
}

func TestResize_ScalesAnUprightWebPOrOneWithoutOrientation(t *testing.T) {
	t.Parallel()
	still := stillWebP(t)

	for name, src := range map[string]imageproxy.Image{
		"plain":                 still,
		"upright":               webpWithExif(t, still, tiffOrientation(1, binary.BigEndian)),
		"upright little endian": webpWithExif(t, still, tiffOrientation(1, binary.LittleEndian)),
		"upright with Exif prefix": webpWithExif(t, still,
			append([]byte("Exif\x00\x00"), tiffOrientation(1, binary.BigEndian)...)),
		"tag value 0": webpWithExif(t, still, tiffOrientation(0, binary.BigEndian)),
		"odd size":    webpWithExif(t, still, append(tiffOrientation(1, binary.LittleEndian), 0)),
		// An odd-length chunk is padded by a byte; miscounting it makes the
		// reader land inside the next chunk and lose the EXIF one.
		"upright behind an odd chunk": webpWithChunks(t, still, chunkRIFF("ICCP", []byte("abc")),
			chunkRIFF("EXIF", tiffOrientation(1, binary.BigEndian))),
		"upright EXIF then XMP": webpWithChunks(t, still, nil, append(
			chunkRIFF("EXIF", append(tiffOrientation(1, binary.BigEndian), 0)), chunkRIFF("XMP ", []byte("<x/>"))...)),
		"upright behind a chunk naming EXIF": webpWithChunks(t, still, chunkRIFF("ICCP", []byte("EXIF!!")),
			chunkRIFF("EXIF", tiffOrientation(1, binary.BigEndian))),
	} {
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err, name)
		assert.Equal(t, "image/png", out.ContentType, name)
		w, _ := dims(t, out)
		assert.Equal(t, 320, w, name)
	}
}

func TestResize_MalformedPNGOrWebPMetadataReturnsTheOriginal(t *testing.T) {
	t.Parallel()
	plain := encodePNG(t, noisy(1200, 900))
	still := stillWebP(t)
	good := tiffOrientation(6, binary.BigEndian)

	for name, src := range map[string]imageproxy.Image{
		"png: length past the end": pngWithLength(plain, 0x7fffffff),
		"png: huge length":         pngWithLength(plain, 0xffffffff),
		"png: truncated tiff":      pngWithChunk(t, plain, "eXIf", good[:6], false),
		"png: ifd out of range":    pngWithChunk(t, plain, "eXIf", []byte("MM\x00\x2a\xff\xff\xff\xff\x00\x01"), false),
		"png: entry count too big": pngWithChunk(t, plain, "eXIf", []byte("MM\x00\x2a\x00\x00\x00\x08\xff\xff\x01\x12"), false),
		"png: empty":               pngWithChunk(t, plain, "eXIf", nil, false),
		"webp: truncated tiff":     webpWithExif(t, still, good[:6]),
		"webp: ifd out of range":   webpWithExif(t, still, []byte("II\x2a\x00\xff\xff\xff\x7f\x01\x00")),
		"webp: empty":              webpWithExif(t, still, nil),
		"webp: chunk past the end": webpChunkLength(t, webpWithExif(t, still, good), 0xffffffff),
	} {
		out, err := imageproxy.Resize(t.Context(), src, 320)

		require.NoError(t, err, name)
		assert.Equal(t, src, out, name)
	}
}

func pngWithLength(src imageproxy.Image, n uint32) imageproxy.Image {
	data := append([]byte{}, src.Data...)
	binary.BigEndian.PutUint32(data[33:], n) // the length of the chunk after IHDR

	return imageproxy.Image{ContentType: "image/png", Data: data}
}

// webpChunkLength sets the declared length of the EXIF chunk, found by walking
// the RIFF chunk list rather than searching for the name, which pixel data may
// contain.
func webpChunkLength(t *testing.T, src imageproxy.Image, n uint32) imageproxy.Image {
	t.Helper()
	data := append([]byte{}, src.Data...)
	for pos := 12; pos+8 <= len(data); {
		size := int(binary.LittleEndian.Uint32(data[pos+4:]))
		if string(data[pos:pos+4]) == "EXIF" {
			binary.LittleEndian.PutUint32(data[pos+4:], n)

			return imageproxy.Image{ContentType: "image/webp", Data: data}
		}
		pos += 8 + size + size&1
	}
	require.Fail(t, "no EXIF chunk")

	return imageproxy.Image{}
}

// pngAfterIEND appends a chunk after the IEND chunk.
func pngAfterIEND(src imageproxy.Image, kind string, body []byte) imageproxy.Image {
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(body))) //nolint:gosec // a few bytes
	chunk = append(chunk, kind...)
	chunk = append(chunk, body...)
	chunk = append(chunk, pngCRC(chunk[4:])...)

	return imageproxy.Image{ContentType: "image/png", Data: append(append([]byte{}, src.Data...), chunk...)}
}
