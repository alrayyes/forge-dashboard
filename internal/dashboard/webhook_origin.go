package dashboard

import (
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// WebhookOriginProblem says why a forge can't deliver a webhook to origin, the
// dashboard's own public address, or returns "" when it can. A hook pointed at
// localhost, a private address or plain HTTP would be created and then never
// fire, so the pass makes none (#4018).
func WebhookOriginProblem(origin string) string {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return "the dashboard's public origin is not set to a full URL"
	}
	if u.Scheme != "https" {
		return "the dashboard's public origin must use HTTPS for a forge to deliver to it"
	}
	if isPrivateHost(u.Hostname()) {
		return "the dashboard's public origin points at localhost or a private address a forge can't reach"
	}

	return ""
}

func isPrivateHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if addr, ok := parseHostIP(host); ok {
		return !publicAddr(addr.Unmap())
	}
	if !strings.Contains(host, ".") {
		return true
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".lan", ".home.arpa"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}

	return false
}

// cgnat is the carrier-grade NAT range (RFC 6598), which IsPrivate leaves out.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// publicAddr reports whether a forge on the internet could reach addr.
func publicAddr(addr netip.Addr) bool {
	if addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast() || addr.IsUnspecified() {
		return false
	}
	if addr.Is4() && (addr.As4()[0] == 0 || cgnat.Contains(addr)) {
		return false
	}

	return true
}

// parseHostIP reads host as an IP address the way a resolver would: standard
// IPv6 and dotted IPv4, plus the short, hex, octal and single-number IPv4
// forms (127.1, 0x7f.1, 2130706433, 0177.0.0.1) that a browser or libc turns
// into an address even though net/netip refuses them.
func parseHostIP(host string) (netip.Addr, bool) {
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr, true
	}
	parts := strings.Split(host, ".")
	if len(parts) > 4 {
		return netip.Addr{}, false
	}
	var value uint64
	for i, part := range parts {
		if part == "" || strings.ContainsAny(part, "_+-") {
			return netip.Addr{}, false
		}
		n, err := strconv.ParseUint(part, 0, 32)
		if err != nil {
			return netip.Addr{}, false
		}
		if i == len(parts)-1 {
			// The last part fills every byte left over.
			if n >= 1<<(8*(5-len(parts))) {
				return netip.Addr{}, false
			}
			value = value<<(8*(5-len(parts))) | n

			break
		}
		if n > 255 {
			return netip.Addr{}, false
		}
		value = value<<8 | n
	}

	return netip.AddrFrom4([4]byte{byte(value >> 24), byte(value >> 16), byte(value >> 8), byte(value)}), true
}
