// Package hostname compares host names the way DNS does: ignoring the case of
// ASCII letters and nothing else.
package hostname

import "strings"

// Fold lowers the ASCII letters of host and leaves every other byte as it is.
func Fold(host string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + ('a' - 'A')
		}

		return r
	}, host)
}

// Equal reports whether two host names are the same, ignoring ASCII case.
func Equal(a, b string) bool { return Fold(a) == Fold(b) }
