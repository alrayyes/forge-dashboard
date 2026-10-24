package api

import (
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
)

// warnNoForwardedClient keeps the misconfiguration to one log line, not one per request.
var warnNoForwardedClient sync.Once

// limitAuthAttempts counts a request to a sign-in or registration endpoint
// against the client's address, and answers 429 with Retry-After once the
// address is over its allowance. These endpoints take requests from anyone, and
// each begin parks a ceremony in a store with a fixed capacity, so an address
// that can call them freely can push the owner's pending sign-in out.
//
// The limit is per address, never per account: the sign-in names no user, and a
// limit on a name would let a stranger lock the owner out. A trusted proxy that
// forwards no client address leaves nothing to tell visitors apart, so those
// requests share one bucket, larger than an address's. That bucket alone, at
// most 70 requests in a ceremony's five minutes, cannot fill the store of 100,
// but it can be used up and 429 the owner for a while. Addresses that do
// forward add their own allowance on top, so the total is not capped at 100.
// A nil limiter lets every request through.
func limitAuthAttempts(deps Deps, next http.Handler) http.Handler {
	if deps.AuthLimiter == nil {
		return next
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var (
			allowed bool
			wait    time.Duration
		)
		if client, known := ratelimit.ClientAddr(r, deps.TrustedProxies); known {
			allowed, wait = deps.AuthLimiter.Allow(client)
		} else {
			warnNoForwardedClient.Do(func() {
				slog.Warn("a trusted proxy forwarded no client address, so its requests share one sign-in limit;"+
					" forward X-Forwarded-For, or set TRUSTED_PROXIES=none if nothing sits in front (see TRUSTED_PROXIES)",
					"peer", client)
			})
			allowed, wait = deps.AuthLimiter.AllowUnattributed()
		}
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
