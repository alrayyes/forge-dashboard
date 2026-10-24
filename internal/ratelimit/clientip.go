package ratelimit

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
)

// defaultProxies are the ranges a reverse proxy in front of this service sits
// in: loopback, private networks (a container network among them) and
// link-local. A peer outside them is on the internet, so its headers are its
// own words and are never read.
var defaultProxies = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

// ErrBadProxy is a TRUSTED_PROXIES entry that is neither an address nor a CIDR prefix.
var ErrBadProxy = errors.New("neither an address nor a CIDR prefix")

// ParseProxies reads a comma-separated list of CIDR prefixes and bare
// addresses naming the reverse proxies to trust. Empty means the private
// ranges; "none" means no proxy is trusted.
func ParseProxies(spec string) ([]netip.Prefix, error) {
	spec = strings.TrimSpace(spec)
	switch strings.ToLower(spec) {
	case "":
		return defaultProxies, nil
	case "none":
		return nil, nil
	}

	var out []netip.Prefix
	for item := range strings.SplitSeq(spec, ",") {
		item = strings.TrimSpace(item)
		if prefix, err := netip.ParsePrefix(item); err == nil {
			out = append(out, prefix)

			continue
		}
		addr, err := netip.ParseAddr(item)
		if err != nil {
			return nil, fmt.Errorf("%q is %w", item, ErrBadProxy)
		}
		out = append(out, netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()))
	}

	return out, nil
}

// ClientAddr is the address r counts against: the connection's own, unless that
// is a trusted proxy. Then the client is the first address in X-Forwarded-For,
// read from the right, that is not itself a trusted proxy. The right end is
// what the nearest proxy wrote; everything left of it was supplied by the
// client and can say anything. An IPv6 client is keyed by its /64, the smallest
// block a network hands out, so one host cannot spread across its addresses.
func ClientAddr(r *http.Request, trusted []netip.Prefix) string {
	peer := peerAddr(r)
	client := peer
	if contains(trusted, peer) {
		client = forwardedClient(r.Header.Values("X-Forwarded-For"), trusted, peer)
	}

	return key(client)
}

func peerAddr(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}

	return addr.Unmap()
}

func forwardedClient(headers []string, trusted []netip.Prefix, peer netip.Addr) netip.Addr {
	var hops []string
	for _, h := range headers {
		hops = slices.AppendSeq(hops, strings.SplitSeq(h, ","))
	}
	for _, hop := range slices.Backward(hops) {
		addr, err := netip.ParseAddr(strings.TrimSpace(hop))
		if err != nil {
			return peer
		}
		addr = addr.Unmap()
		if !contains(trusted, addr) {
			return addr
		}
	}

	return peer
}

func contains(prefixes []netip.Prefix, addr netip.Addr) bool {
	for _, p := range prefixes {
		if p.Contains(addr) {
			return true
		}
	}

	return false
}

func key(addr netip.Addr) string {
	if addr.Is6() {
		if prefix, err := addr.Prefix(64); err == nil {
			return prefix.Addr().String()
		}
	}

	return addr.String()
}
