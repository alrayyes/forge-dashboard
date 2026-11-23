package dashboard

import (
	"net"
	"net/url"
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
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
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
