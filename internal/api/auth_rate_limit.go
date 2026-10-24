package api

import (
	"math"
	"net/http"
	"strconv"

	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
)

// limitAuthAttempts counts a request to a sign-in or registration endpoint
// against the client's address, and answers 429 with Retry-After once the
// address is over its allowance. These endpoints take requests from anyone, and
// each begin parks a ceremony in a store with a fixed capacity, so an address
// that can call them freely can push the owner's pending sign-in out.
//
// The limit is per address, never per account: the sign-in names no user, and a
// limit on a name would let a stranger lock the owner out. A nil limiter lets
// every request through.
func limitAuthAttempts(deps Deps, next http.Handler) http.Handler {
	if deps.AuthLimiter == nil {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		allowed, wait := deps.AuthLimiter.Allow(ratelimit.ClientAddr(r, deps.TrustedProxies))
		if allowed {
			next.ServeHTTP(w, r)

			return
		}

		seconds := int(math.Ceil(wait.Seconds()))
		seconds = max(seconds, 1)
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		writeJSON(w, http.StatusTooManyRequests, errorBody(
			"too many sign-in attempts, try again in "+secondsText(seconds),
		))
	})
}

func secondsText(n int) string {
	if n == 1 {
		return "1 second"
	}

	return strconv.Itoa(n) + " seconds"
}
