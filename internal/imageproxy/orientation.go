package imageproxy

import "encoding/binary"

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

func exifOrientation(seg []byte) int {
	const header = "Exif\x00\x00"
	if len(seg) < len(header)+8 || string(seg[:len(header)]) != header {
		return 0
	}
	tiff := seg[len(header):]
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	ifd := int(order.Uint32(tiff[4:]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0
	}
	n := int(order.Uint16(tiff[ifd:]))
	for i := range n {
		e := ifd + 2 + i*12
		if e+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[e:]) == 0x0112 {
			return int(order.Uint16(tiff[e+8:]))
		}
	}

	return 0
}
