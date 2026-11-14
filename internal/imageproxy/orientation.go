package imageproxy

import (
	"bytes"
	"encoding/binary"
)

// unreadable is what the PNG and WebP readers return for a metadata block that
// is there but can't be parsed. It counts as rotated: with no way to tell, the
// original is the safe thing to send.
const unreadable = -1

// orientation reads the EXIF orientation of img, by its content type: 1 is
// upright, 2 to 8 are mirrored or rotated, 0 when there is none, and unreadable
// when PNG or WebP metadata is present but malformed. JPEG, as before, treats
// anything it can't read as none.
func orientation(img Image) int {
	switch img.ContentType {
	case "image/jpeg":
		return jpegOrientation(img.Data)
	case "image/png":
		return pngOrientation(img.Data)
	case "image/webp":
		return webpOrientation(img.Data)
	}

	return 0
}

// jpegOrientation reads the EXIF orientation of a JPEG: 1 is upright, 2 to 8
// are mirrored or rotated, 0 when there is none or it can't be read. Only the
// first APP1 Exif segment is looked at, which is where cameras put it.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0
	}
	pos := 2
	for pos+4 <= len(data) && data[pos] == 0xFF {
		marker := data[pos+1]
		if marker == 0xDA || marker == 0xD9 { // image data or end: no Exif follows
			return 0
		}
		size := int(binary.BigEndian.Uint16(data[pos+2:]))
		if size < 2 || pos+2+size > len(data) {
			return 0
		}
		if marker == 0xE1 {
			if o := exifOrientation(data[pos+4 : pos+2+size]); o != 0 {
				return o
			}
		}
		pos += 2 + size
	}

	return 0
}

// pngOrientation reads the eXIf chunk of a PNG, wherever it sits before IEND.
func pngOrientation(data []byte) int {
	const sig = "\x89PNG\r\n\x1a\n"
	if !bytes.HasPrefix(data, []byte(sig)) {
		return 0
	}
	pos := len(sig)
	for pos+12 <= len(data) {
		size := int64(binary.BigEndian.Uint32(data[pos:]))
		kind := string(data[pos+4 : pos+8])
		end := int64(pos) + 12 + size
		if end > int64(len(data)) {
			return unreadable
		}
		switch kind {
		case "eXIf":
			return tiffOrientationOrUnreadable(data[pos+8 : end-4])
		case "IEND":
			return 0
		}
		pos = int(end)
	}

	return 0
}

// webpOrientation reads the EXIF chunk of an extended WebP. A simple WebP has
// no metadata chunks, so it reads as none.
func webpOrientation(data []byte) int {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0
	}
	pos := 12
	for pos+8 <= len(data) {
		size := int64(binary.LittleEndian.Uint32(data[pos+4:]))
		start := int64(pos) + 8
		if start+size > int64(len(data)) {
			return unreadable
		}
		if string(data[pos:pos+4]) == "EXIF" {
			body := data[start : start+size]
			// Some writers keep the "Exif\0\0" prefix a JPEG segment has.
			body = bytes.TrimPrefix(body, []byte("Exif\x00\x00"))

			return tiffOrientationOrUnreadable(body)
		}
		pos = int(start + size + size&1)
	}

	return 0
}

func tiffOrientationOrUnreadable(tiff []byte) int {
	o, ok := tiffOrientation(tiff)
	if !ok {
		return unreadable
	}

	return o
}

func exifOrientation(seg []byte) int {
	const header = "Exif\x00\x00"
	if !bytes.HasPrefix(seg, []byte(header)) {
		return 0
	}
	o, _ := tiffOrientation(seg[len(header):])

	return o
}

// tiffOrientation finds the orientation tag in a TIFF block. ok is false when
// the block is too short or points outside itself; o is 0 when it holds no tag.
func tiffOrientation(tiff []byte) (o int, ok bool) {
	if len(tiff) < 8 {
		return 0, false
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0, false
	}
	ifd := int64(order.Uint32(tiff[4:]))
	if ifd < 8 || ifd+2 > int64(len(tiff)) {
		return 0, false
	}
	n := int(order.Uint16(tiff[ifd:]))
	for i := range n {
		e := int(ifd) + 2 + i*12
		if e+12 > len(tiff) {
			return 0, false
		}
		if order.Uint16(tiff[e:]) == 0x0112 {
			return int(order.Uint16(tiff[e+8:])), true
		}
	}

	return 0, true
}
