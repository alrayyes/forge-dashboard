package main

import (
	"fmt"
	"net/netip"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
)

const (
	// authBurst and authEvery are the allowance of one client address across
	// the sign-in and registration endpoints: ten requests at once, then one
	// every six seconds. A sign-in is two requests. Over any five minutes, the
	// life of a pending ceremony, one address makes at most 60, well short of
	// the 100 the ceremony store holds. Requests that name no client share one
	// bucket of twice the burst, at most 70 in the same time. The buckets add
	// up, so 100 is a limit on each of them, not a total guarantee.
	authBurst = 10
	authEvery = 6 * time.Second
)

// resolveAuthLimit is the limiter for the sign-in and registration endpoints
// and the proxies whose X-Forwarded-For it believes, read from the
// TRUSTED_PROXIES setting. A build that has switched the limit off gets no
// limiter.
func resolveAuthLimit(trustedProxies string, enabled bool) (*ratelimit.Limiter, []netip.Prefix, error) {
	proxies, err := ratelimit.ParseProxies(trustedProxies)
	if err != nil {
		return nil, nil, fmt.Errorf("TRUSTED_PROXIES: %w", err)
	}
	if !enabled {
		return nil, proxies, nil
	}

	return ratelimit.New(authBurst, authEvery, time.Now), proxies, nil
}
