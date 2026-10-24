package ratelimit_test

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func request(remote string, xff ...string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}

	return r
}

// clientKey is the address r counts against, for tests that only care which.
func clientKey(r *http.Request, trusted []netip.Prefix) string {
	key, _ := ratelimit.ClientAddr(r, trusted)

	return key
}

func proxies(tb testing.TB, spec string) []netip.Prefix {
	tb.Helper()
	p, err := ratelimit.ParseProxies(spec)
	require.NoError(tb, err)

	return p
}

func TestClientAddr_DirectPeer_IsTheConnectionAddress(t *testing.T) {
	t.Parallel()
	r := request("203.0.113.9:5555")

	assert.Equal(t, "203.0.113.9", clientKey(r, proxies(t, "10.0.0.0/8")))
}

func TestClientAddr_ForwardedHeaderFromAnUntrustedPeer_IsIgnored(t *testing.T) {
	t.Parallel()
	r := request("203.0.113.9:5555", "198.51.100.1")

	assert.Equal(t, "203.0.113.9", clientKey(r, proxies(t, "10.0.0.0/8")))
}

func TestClientAddr_TrustedProxy_UsesTheForwardedClient(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000", "198.51.100.1")

	assert.Equal(t, "198.51.100.1", clientKey(r, proxies(t, "10.0.0.0/8")))
}

func TestClientAddr_SpoofedLeftmostEntry_IsNotTrusted(t *testing.T) {
	t.Parallel()
	// The client sent "1.2.3.4"; the proxy appended the address it really saw.
	r := request("10.0.0.2:4000", "1.2.3.4, 198.51.100.1")

	assert.Equal(t, "198.51.100.1", clientKey(r, proxies(t, "10.0.0.0/8")))
}

func TestClientAddr_ChainOfTrustedProxies_SkipsEachOfThem(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000", "198.51.100.1", "10.0.0.7")

	assert.Equal(t, "198.51.100.1", clientKey(r, proxies(t, "10.0.0.0/8")))
}

func TestClientAddr_TrustedProxyWithNoHeader_NamesNoClient(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000")

	_, ok := ratelimit.ClientAddr(r, proxies(t, "10.0.0.0/8"))

	assert.False(t, ok, "every visitor would share the proxy's address")
}

func TestClientAddr_GarbageInTheHeader_NamesNoClient(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000", "not-an-address")

	_, ok := ratelimit.ClientAddr(r, proxies(t, "10.0.0.0/8"))

	assert.False(t, ok)
}

func TestClientAddr_HeaderOfOnlyTrustedProxies_NamesNoClient(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000", "10.0.0.7")

	_, ok := ratelimit.ClientAddr(r, proxies(t, "10.0.0.0/8"))

	assert.False(t, ok)
}

func TestClientAddr_UntrustedPeer_AlwaysNamesAClient(t *testing.T) {
	t.Parallel()
	r := request("203.0.113.9:5555")

	key, ok := ratelimit.ClientAddr(r, proxies(t, "10.0.0.0/8"))

	assert.True(t, ok)
	assert.Equal(t, "203.0.113.9", key)
}

func TestClientAddr_NoTrustedProxies_NeverReadsTheHeader(t *testing.T) {
	t.Parallel()
	r := request("10.0.0.2:4000", "198.51.100.1")

	assert.Equal(t, "10.0.0.2", clientKey(r, proxies(t, "none")))
}

func TestClientAddr_IPv6_SharesOneKeyPerSlash64(t *testing.T) {
	t.Parallel()
	a := request("[2001:db8:1:2:aaaa::1]:80")
	b := request("[2001:db8:1:2:bbbb::9]:80")
	c := request("[2001:db8:1:3::1]:80")

	assert.Equal(t, clientKey(a, nil), clientKey(b, nil))
	assert.NotEqual(t, clientKey(a, nil), clientKey(c, nil))
}

func TestClientAddr_IPv4MappedIPv6_IsTheIPv4Address(t *testing.T) {
	t.Parallel()
	r := request("[::ffff:203.0.113.9]:80")

	assert.Equal(t, "203.0.113.9", clientKey(r, nil))
}

func TestParseProxies(t *testing.T) {
	t.Parallel()

	t.Run("empty means the private ranges a reverse proxy sits in", func(t *testing.T) {
		t.Parallel()
		p := proxies(t, "")
		assert.Equal(t, "198.51.100.1", clientKey(request("10.0.0.2:1", "198.51.100.1"), p))
		assert.Equal(t, "198.51.100.1", clientKey(request("127.0.0.1:1", "198.51.100.1"), p))
		assert.Equal(t, "198.51.100.1", clientKey(request("172.18.0.3:1", "198.51.100.1"), p))
		assert.Equal(t, "203.0.113.9", clientKey(request("203.0.113.9:1", "198.51.100.1"), p))
	})

	t.Run("a list of prefixes and bare addresses", func(t *testing.T) {
		t.Parallel()
		p := proxies(t, "192.0.2.0/24, 203.0.113.5")
		assert.Equal(t, "198.51.100.1", clientKey(request("192.0.2.8:1", "198.51.100.1"), p))
		assert.Equal(t, "198.51.100.1", clientKey(request("203.0.113.5:1", "198.51.100.1"), p))
		assert.Equal(t, "203.0.113.6", clientKey(request("203.0.113.6:1", "198.51.100.1"), p))
	})

	t.Run("a bad entry is an error", func(t *testing.T) {
		t.Parallel()
		_, err := ratelimit.ParseProxies("10.0.0.0/8, nonsense")
		assert.Error(t, err)
	})
}
