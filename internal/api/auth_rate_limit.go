package api

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"sync"

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
// every request through, and so does a trusted proxy that forwards no client
// address: counting it would put every visitor in one bucket, where a stranger
// could keep the owner at 429. Better an unlimited endpoint, said once in the
// log, than a sign-in the owner cannot reach.
// warnNoForwardedClient keeps the misconfiguration to one log line, not one per request.
var warnNoForwardedClient sync.Once

func limitAuthAttempts(deps Deps, next http.Handler) http.Handler {
	if deps.AuthLimiter == nil {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		client, known := ratelimit.ClientAddr(r, deps.TrustedProxies)
		if !known {
			warnNoForwardedClient.Do(func() {
				slog.Warn("a trusted proxy forwarded no client address; sign-in requests are not rate limited" +
					" until it sends X-Forwarded-For (see TRUSTED_PROXIES)")
			})
			next.ServeHTTP(w, r)

			return
		}

		allowed, wait := deps.AuthLimiter.Allow(client)
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
