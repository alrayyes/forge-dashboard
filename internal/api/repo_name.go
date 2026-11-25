package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
)

// splitFullName splits "owner/repo" into its two halves. false for
// anything else: no slash, more than one, an empty side, a "." or ".." side,
// or a character that could change the forge URL it is later put into (a
// query, a fragment, an escape, whitespace or a control character).
func splitFullName(fullName string) (owner, name string, ok bool) {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 || !safeRepoSegment(parts[0]) || !safeRepoSegment(parts[1]) {
		return "", "", false
	}

	return parts[0], parts[1], true
}

// safeRepoSegment reports whether s can be one half of an "owner/repo" name
// without altering the path it is joined into.
func safeRepoSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}

	return !strings.ContainsFunc(s, func(r rune) bool {
		return r <= ' ' || r == 0x7f || strings.ContainsRune(`?#%\`, r)
	})
}

// clientErrorStatus maps a forge error's Kind to the HTTP status a caller
// should see — the same coarse categories ForgeHealth.ErrorKind already
// classifies forge failures into elsewhere, applied here to a single
// write instead of a whole snapshot. Shared by every endpoint that writes
// to a forge (pull-request actions, issue actions), not just one.
func clientErrorStatus(err error) int {
	if errors.Is(err, github.ErrUnknownRepository) {
		return http.StatusNotFound
	}
	var clientErr *dashboard.ClientError
	if !errors.As(err, &clientErr) {
		return http.StatusBadGateway
	}
	switch clientErr.Kind {
	case dashboard.ForgeErrorUnauthorized:
		return http.StatusForbidden
	case dashboard.ForgeErrorNotFound:
		return http.StatusNotFound
	case dashboard.ForgeErrorConflict:
		return http.StatusConflict
	case dashboard.ForgeErrorRateLimited:
		return http.StatusTooManyRequests
	default:
		return http.StatusBadGateway
	}
}
