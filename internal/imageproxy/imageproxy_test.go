package imageproxy_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/imageproxy"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// onePixelPNG is the smallest valid PNG, so http.DetectContentType agrees it is one.
var onePixelPNG, _ = base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")

func serve(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(h)
	t.Cleanup(s.Close)

	return s
}

func png(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(onePixelPNG)
}

// instance is a proxy trusted to reach a configured forge, even on a loopback
// or private address (a self-hosted Forgejo often is one).
func instance(s *httptest.Server, token string) *imageproxy.Proxy {
	return imageproxy.New(imageproxy.Config{
		Hosts:      []string{s.Listener.Addr().String()},
		Scheme:     "http",
		Token:      token,
		TokenHost:  s.Listener.Addr().String(),
		AllowLocal: true,
	})
}

func TestFetch_ServesAnImageFromAnAllowedHost(t *testing.T) {
	t.Parallel()
	s := serve(t, png)

	img, err := instance(s, "").Fetch(t.Context(), s.URL+"/attachments/abc")

	require.NoError(t, err)
	assert.Equal(t, "image/png", img.ContentType)
	assert.Equal(t, onePixelPNG, img.Data)
}

func TestFetch_RefusesAHostOutsideTheAllowedSet(t *testing.T) {
	t.Parallel()
	var hits int
	var mu sync.Mutex
	other := serve(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		png(w, r)
	})
	allowed := serve(t, png)

	_, err := instance(allowed, "").Fetch(t.Context(), other.URL+"/x.png")

	require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed)
	mu.Lock()
	defer mu.Unlock()
	assert.Zero(t, hits, "no request may reach a host outside the set")
}

func TestFetch_RefusesMalformedAndOddAddresses(t *testing.T) {
	t.Parallel()
	s := serve(t, png)
	p := instance(s, "")
	host := s.Listener.Addr().String()

	for name, raw := range map[string]string{
		"relative":          "/attachments/abc",
		"scheme-relative":   "//" + host + "/a.png",
		"wrong scheme":      "https://" + host + "/a.png",
		"file":              "file:///etc/passwd",
		"data":              "data:image/png;base64,AAAA",
		"userinfo":          "http://user:pw@" + host + "/a.png",
		"userinfo trick":    "http://" + host + "@evil.example/a.png",
		"empty":             "",
		"lookalike suffix":  "http://" + host + ".evil.example/a.png",
		"lookalike subhost": "http://evil." + host + "/a.png",
	} {
		_, err := p.Fetch(t.Context(), raw)
		require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed, name)
	}
}

func TestFetch_RefusesARedirectToAnotherHost(t *testing.T) {
	t.Parallel()
	var hits int
	var mu sync.Mutex
	elsewhere := serve(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		png(w, r)
	})
	allowed := serve(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/x.png", http.StatusFound)
	})

	_, err := instance(allowed, "secret").Fetch(t.Context(), allowed.URL+"/a")

	require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed)
	mu.Lock()
	defer mu.Unlock()
	assert.Zero(t, hits, "the redirect target must never be contacted")
}

// A listed host that redirects somewhere unlisted is not the routine miss of
// an avatar nobody serves: the caller logs it as a probe, so the error must
// not read as a plain host-list miss.
func TestFetch_ARedirectToAnUnlistedHostIsNotAPlainListMiss(t *testing.T) {
	t.Parallel()
	elsewhere := serve(t, png)
	allowed := serve(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, elsewhere.URL+"/x.png", http.StatusFound)
	})

	_, err := instance(allowed, "secret").Fetch(t.Context(), allowed.URL+"/a")

	require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed)
	assert.NotErrorIs(t, err, imageproxy.ErrHostNotListed)
}

func TestFetch_FollowsARedirectWithinTheAllowedSet(t *testing.T) {
	t.Parallel()
	allowed := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/start" {
			http.Redirect(w, r, "/final.png", http.StatusFound)

			return
		}
		png(w, r)
	})

	img, err := instance(allowed, "").Fetch(t.Context(), allowed.URL+"/start")

	require.NoError(t, err)
	assert.Equal(t, onePixelPNG, img.Data)
}

func TestFetch_StopsAnEndlessRedirect(t *testing.T) {
	t.Parallel()
	allowed := serve(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Path+"x", http.StatusFound) //nolint:gosec // a test server looping on itself
	})

	_, err := instance(allowed, "").Fetch(t.Context(), allowed.URL+"/a")

	require.ErrorIs(t, err, imageproxy.ErrUpstream)
}

func TestFetch_RefusesAPrivateAddressUnlessTheHostIsTheConfiguredInstance(t *testing.T) {
	t.Parallel()
	s := serve(t, png) // listens on 127.0.0.1
	p := imageproxy.New(imageproxy.Config{
		Hosts:  []string{s.Listener.Addr().String()},
		Scheme: "http",
		// AllowLocal false: a fixed public host that resolved to a private
		// address (DNS rebinding, a poisoned record) is refused at dial time.
	})

	_, err := p.Fetch(t.Context(), s.URL+"/a.png")

	require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed)
}

func TestFetch_RefusesAContentTypeThatIsNotAnImage(t *testing.T) {
	t.Parallel()
	for name, body := range map[string]struct {
		ctype string
		data  []byte
	}{
		"html":                   {"text/html", []byte("<script>alert(1)</script>")},
		"svg":                    {"image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)},
		"html claiming png":      {"image/png", []byte("<html><script>alert(1)</script></html>")},
		"json":                   {"application/json", []byte(`{"a":1}`)},
		"png claiming nothing":   {"", []byte("plain text, not an image")},
		"octet-stream non-image": {"application/octet-stream", []byte("MZ\x90\x00 executable")},
	} {
		s := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", body.ctype)
			_, _ = w.Write(body.data)
		})

		_, err := instance(s, "").Fetch(t.Context(), s.URL+"/a")

		require.ErrorIs(t, err, imageproxy.ErrNotImage, name)
	}
}

func TestFetch_TakesTheTypeFromTheBytesNotTheHeader(t *testing.T) {
	t.Parallel()
	s := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(onePixelPNG)
	})

	img, err := instance(s, "").Fetch(t.Context(), s.URL+"/a")

	require.NoError(t, err)
	assert.Equal(t, "image/png", img.ContentType)
}

func TestFetch_RefusesAnImageOverTheSizeCap(t *testing.T) {
	t.Parallel()
	big := append(bytes.Clone(onePixelPNG), make([]byte, imageproxy.MaxBytes)...)

	t.Run("by its declared length", func(t *testing.T) {
		t.Parallel()
		s := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(big)
		})
		_, err := instance(s, "").Fetch(t.Context(), s.URL+"/a")
		require.ErrorIs(t, err, imageproxy.ErrTooLarge)
	})

	t.Run("by its bytes when no length is declared", func(t *testing.T) {
		t.Parallel()
		s := serve(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			w.(http.Flusher).Flush() // chunked: no Content-Length
			_, _ = w.Write(big)
		})
		_, err := instance(s, "").Fetch(t.Context(), s.URL+"/a")
		require.ErrorIs(t, err, imageproxy.ErrTooLarge)
	})
}

func TestFetch_GivesUpOnASlowHost(t *testing.T) {
	t.Parallel()
	s := serve(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(5 * time.Second):
		}
		png(w, r)
	})
	p := imageproxy.New(imageproxy.Config{
		Hosts: []string{s.Listener.Addr().String()}, Scheme: "http", AllowLocal: true,
		Timeout: 100 * time.Millisecond,
	})

	_, err := p.Fetch(t.Context(), s.URL+"/a")

	require.ErrorIs(t, err, imageproxy.ErrUpstream)
}

func TestFetch_MapsTheForgesRefusals(t *testing.T) {
	t.Parallel()
	for status, want := range map[int]error{
		http.StatusNotFound:     imageproxy.ErrNotFound,
		http.StatusUnauthorized: imageproxy.ErrForbidden,
		http.StatusForbidden:    imageproxy.ErrForbidden,
		http.StatusBadGateway:   imageproxy.ErrUpstream,
	} {
		s := serve(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(status) })

		_, err := instance(s, "").Fetch(t.Context(), s.URL+"/a")

		require.ErrorIs(t, err, want, status)
	}
}

func TestFetch_SendsTheTokenOnlyToItsOwnHost(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var seen []string
	record := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Host+"="+r.Header.Get("Authorization")+"|"+r.Header.Get("Referer")+"|"+r.Header.Get("Cookie"))
		mu.Unlock()
		png(w, r)
	}
	home := serve(t, record)
	sibling := serve(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hop" {
			mu.Lock()
			seen = append(seen, r.Host+"="+r.Header.Get("Authorization")+"|"+r.Header.Get("Referer")+"|"+r.Header.Get("Cookie"))
			mu.Unlock()
			http.Redirect(w, r, home.URL+"/back", http.StatusFound)

			return
		}
		record(w, r)
	})
	// Both hosts are allowed, only the first holds the token. The sibling
	// bounces to home, which is allowed too, so the hop is followed.
	p := imageproxy.New(imageproxy.Config{
		Hosts:      []string{home.Listener.Addr().String(), sibling.Listener.Addr().String()},
		Scheme:     "http",
		Token:      "s3cret",
		TokenHost:  home.Listener.Addr().String(),
		AllowLocal: true,
	})

	_, err := p.Fetch(t.Context(), home.URL+"/a")
	require.NoError(t, err)
	_, err = p.Fetch(t.Context(), sibling.URL+"/hop")
	require.NoError(t, err)

	mu.Lock()
	defer mu.Unlock()
	require.Len(t, seen, 3)
	assert.Equal(t, home.Listener.Addr().String()+"=token s3cret||", seen[0])
	// The sibling is not the token's host: no credential, no referrer, no cookie.
	assert.Equal(t, sibling.Listener.Addr().String()+"=||", seen[1])
	assert.Equal(t, home.Listener.Addr().String()+"=token s3cret||", seen[2])
}

func TestFetch_HonoursACancelledContext(t *testing.T) {
	t.Parallel()
	s := serve(t, png)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	_, err := instance(s, "").Fetch(ctx, s.URL+"/a")

	require.Error(t, err)
}

func TestFetch_RefusesSpecialPurposeAddresses(t *testing.T) {
	t.Parallel()
	for name, host := range map[string]string{
		"shared address space":    "100.64.0.1",
		"benchmarking":            "198.18.0.1",
		"IETF protocol":           "192.0.0.8",
		"NAT64":                   "[64:ff9b::808:808]",
		"6to4":                    "[2002:808:808::1]",
		"TEST-NET-1":              "192.0.2.1",
		"TEST-NET-2":              "198.51.100.1",
		"TEST-NET-3":              "203.0.113.1",
		"class E":                 "240.0.0.1",
		"IPv6 documentation":      "[2001:db8::1]",
		"local-use NAT64":         "[64:ff9b:1::1]",
		"mapped loopback":         "[::ffff:127.0.0.1]",
		"RFC 9637 documentation":  "[3fff::1]",
		"this network":            "0.0.0.1",
		"discard prefix":          "[100::1]",
		"6to4 relay anycast":      "192.88.99.1",
		"Teredo":                  "[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
		"IPv6 benchmarking":       "[2001:2::1]",
		"deprecated ORCHID":       "[2001:10::1]",
		"dummy IPv6 prefix":       "[100:0:0:1::1]",
		"SRv6 SIDs":               "[5f00::1]",
		"SRv6 SIDs, far end":      "[5f00:ffff::1]",
		"unassigned 2001:5::":     "[2001:5::1]",
		"unassigned 2001:100::":   "[2001:100::1]",
		"2001:1:: beside anycast": "[2001:1::4]",
		"2001:1:: below anycast":  "[2001:1::]",
		"2001:1:1::":              "[2001:1:1::1]",
		"2001:4:111::":            "[2001:4:111::1]",
		"2001:1f::":               "[2001:1f::1]",
		"2001:40::":               "[2001:40::1]",
		"2001:1ff::":              "[2001:1ff::1]",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			p := imageproxy.New(imageproxy.Config{
				Hosts: []string{host + ":80"}, Scheme: "http", Timeout: 2 * time.Second,
			})

			_, err := p.Fetch(t.Context(), "http://"+host+":80/a.png")

			require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed)
		})
	}
}

// A dial can hand the check an IPv4-mapped address. Only Unmap lets the IPv4
// ranges in specialPurpose catch it, so these go to the check directly.
func TestRefuseNonPublic_UnmapsAnIPv4MappedAddress(t *testing.T) {
	t.Parallel()
	for name, address := range map[string]string{
		"mapped loopback":     "[::ffff:127.0.0.1]:80",
		"mapped TEST-NET-1":   "[::ffff:192.0.2.1]:80",
		"mapped shared space": "[::ffff:100.64.0.1]:80",
		"mapped this network": "[::ffff:0.0.0.1]:80",
		"mapped 6to4 relay":   "[::ffff:192.88.99.1]:80",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			require.Error(t, imageproxy.RefuseNonPublic(address))
		})
	}
}

// 2001::/23 is refused except for the entries the IANA registry marks globally
// reachable (three anycast addresses, AMT, AS112-v6, ORCHIDv2, the drone remote
// ID tags). These stay allowed, as do addresses just outside the block.
func TestRefuseNonPublic_AllowsGloballyReachableIETFProtocolRanges(t *testing.T) {
	t.Parallel()
	for name, address := range map[string]string{
		"PCP anycast":     "[2001:1::1]:80",
		"TURN anycast":    "[2001:1::2]:80",
		"DNS-SD anycast":  "[2001:1::3]:80",
		"ORCHIDv2 end":    "[2001:2f:ffff::1]:80",
		"direct AS112":    "[2620:4f:8000::1]:80",
		"just past /23":   "[2001:200::1]:80",
		"AMT":             "[2001:3::1]:80",
		"AS112-v6":        "[2001:4:112::1]:80",
		"ORCHIDv2":        "[2001:20::1]:80",
		"drone remote ID": "[2001:30::1]:80",
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			require.NoError(t, imageproxy.RefuseNonPublic(address))
		})
	}
}

// A plain miss on the host list is routine (a Gravatar avatar, say). Anything
// else the proxy refuses, such as user info or another scheme, is a probe, and
// the server logs the two at different levels.
func TestProxy_OnlyAPlainHostMissIsNotListed(t *testing.T) {
	t.Parallel()
	s := serve(t, png)
	p := instance(s, "")
	host := s.Listener.Addr().String()

	_, err := p.Fetch(t.Context(), "http://evil.example/a.png")
	require.ErrorIs(t, err, imageproxy.ErrHostNotListed)
	require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed, "still a refusal")

	for name, raw := range map[string]string{
		"userinfo":       "http://user:pw@" + host + "/a.png",
		"userinfo trick": "http://" + host + "@evil.example/a.png",
		"wrong scheme":   "https://" + host + "/a.png",
		"relative":       "/attachments/abc",
	} {
		_, err := p.Fetch(t.Context(), raw)
		require.ErrorIs(t, err, imageproxy.ErrHostNotAllowed, name)
		require.NotErrorIs(t, err, imageproxy.ErrHostNotListed, name)
	}
}

func TestFetchMax_RefusesAnImageOverTheGivenLimit(t *testing.T) {
	t.Parallel()
	big := append(append([]byte{}, onePixelPNG...), make([]byte, 2048)...)
	s := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(big)
	})
	p := instance(s, "")

	_, err := p.FetchMax(t.Context(), s.URL+"/a", 1024)
	require.ErrorIs(t, err, imageproxy.ErrTooLarge)

	img, err := p.FetchMax(t.Context(), s.URL+"/a", len(big))
	require.NoError(t, err)
	assert.Len(t, img.Data, len(big))
}
