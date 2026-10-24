package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
	"github.com/descope/virtualwebauthn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var ceremonyPaths = []string{
	"/api/auth/register/begin",
	"/api/auth/register/finish",
	"/api/auth/login/begin",
	"/api/auth/login/finish",
}

// testClock is a clock the test moves by hand.
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.now
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// limitedServer is a test server whose sign-in endpoints allow burst requests
// per address and then one every `every`. The test client connects from
// loopback, which counts as a trusted proxy unless trusted says otherwise, so a
// request names its client in X-Forwarded-For.
func limitedServer(tb testing.TB, burst int, every time.Duration) (*httptest.Server, *testClock) {
	tb.Helper()

	return limitedServerTrusting(tb, burst, every, []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")})
}

// limitedServerTrusting is limitedServer with its own list of trusted proxies.
func limitedServerTrusting(tb testing.TB, burst int, every time.Duration, trusted []netip.Prefix) (*httptest.Server, *testClock) {
	tb.Helper()
	clock := &testClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	limiter := ratelimit.New(burst, every, clock.Now)
	srv, _, _, _, _, _ := newTestServerWithDatabase(tb, noSources, false, 0, func(d *api.Deps) {
		d.AuthLimiter = limiter
		d.TrustedProxies = trusted
	})

	return srv, clock
}

// reply is what a request got, read in full so nothing is left open.
type reply struct {
	status     int
	retryAfter string
	body       []byte
}

// postFrom posts an empty body to path as the client at addr, the way a reverse
// proxy in front of the server would forward it.
func postFrom(tb testing.TB, srv *httptest.Server, path, addr string) reply {
	tb.Helper()
	req, err := http.NewRequestWithContext(tb.Context(), http.MethodPost, srv.URL+path, strings.NewReader("{}"))
	require.NoError(tb, err)
	req.Header.Set("Content-Type", "application/json")
	if addr != "" {
		req.Header.Set("X-Forwarded-For", addr)
	}
	resp, err := testClient(tb).Do(req)
	require.NoError(tb, err)
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	require.NoError(tb, err)

	return reply{status: resp.StatusCode, retryAfter: resp.Header.Get("Retry-After"), body: body}
}

func TestAuthRateLimit_PastTheBurst_Answers429WithRetryAfter(t *testing.T) {
	t.Parallel()
	for _, path := range ceremonyPaths {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			srv, _ := limitedServer(t, 3, 6*time.Second)
			for range 3 {
				assert.NotEqual(t, http.StatusTooManyRequests, postFrom(t, srv, path, "198.51.100.1").status)
			}

			resp := postFrom(t, srv, path, "198.51.100.1")

			assert.Equal(t, http.StatusTooManyRequests, resp.status)
			assert.Equal(t, "6", resp.retryAfter)
			var body map[string]string
			require.NoError(t, json.Unmarshal(resp.body, &body))
			assert.Contains(t, body["error"], "too many")
			assert.Contains(t, body["error"], "6 seconds")
		})
	}
}

func TestAuthRateLimit_TheFourEndpointsShareOneAllowance(t *testing.T) {
	t.Parallel()
	srv, _ := limitedServer(t, 4, time.Minute)
	for _, path := range ceremonyPaths {
		postFrom(t, srv, path, "198.51.100.1")
	}

	for _, path := range ceremonyPaths {
		assert.Equal(t, http.StatusTooManyRequests, postFrom(t, srv, path, "198.51.100.1").status, path)
	}
}

func TestAuthRateLimit_RetryAfterRoundsUpToWholeSeconds(t *testing.T) {
	t.Parallel()
	srv, clock := limitedServer(t, 1, 6*time.Second)
	postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1")
	clock.advance(2500 * time.Millisecond)

	resp := postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1")

	assert.Equal(t, http.StatusTooManyRequests, resp.status)
	assert.Equal(t, "4", resp.retryAfter)
}

func TestAuthRateLimit_AfterTheWindow_TheAddressIsLetBackIn(t *testing.T) {
	t.Parallel()
	srv, clock := limitedServer(t, 2, 6*time.Second)
	for range 2 {
		postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1")
	}
	require.Equal(t, http.StatusTooManyRequests, postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1").status)

	clock.advance(6 * time.Second)

	assert.NotEqual(t, http.StatusTooManyRequests, postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1").status)
}

func TestAuthRateLimit_OneAddressBeingLimited_LeavesAnotherAlone(t *testing.T) {
	t.Parallel()
	srv, _ := limitedServer(t, 2, time.Minute)
	for range 3 {
		postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1")
	}

	assert.Equal(t, http.StatusTooManyRequests, postFrom(t, srv, "/api/auth/login/begin", "198.51.100.1").status)
	assert.NotEqual(t, http.StatusTooManyRequests, postFrom(t, srv, "/api/auth/login/begin", "203.0.113.7").status)
}

func TestAuthRateLimit_ForwardedHeaderFromAnUntrustedPeer_CannotShakeTheLimit(t *testing.T) {
	t.Parallel()
	// No proxy is trusted, so the loopback peer is the client whatever it claims.
	srv, _ := limitedServerTrusting(t, 2, time.Minute, nil)
	for i := range 2 {
		postFrom(t, srv, "/api/auth/login/begin", "198.51.100."+strconv.Itoa(i))
	}

	resp := postFrom(t, srv, "/api/auth/login/begin", "198.51.100.99")

	assert.Equal(t, http.StatusTooManyRequests, resp.status)
}

func TestAuthRateLimit_OtherEndpoints_AreNotCounted(t *testing.T) {
	t.Parallel()
	srv, _ := limitedServer(t, 1, time.Minute)
	for range 5 {
		resp, err := testClient(t).Get(srv.URL + "/api/auth/registration-status")
		require.NoError(t, err)
		_ = resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode)
	}
}

// The owner signing in from their own address, a few times over, is never
// refused: a sign-in is two requests, the allowance is ten.
func TestAuthRateLimit_OwnerSigningInNormally_IsNeverLimited(t *testing.T) {
	t.Parallel()
	srv, _ := limitedServer(t, 10, 6*time.Second)
	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}

	_, cred, authenticator := registerViaRealCeremony(t, srv)
	for range 3 {
		options := beginLogin(t, srv)
		body := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *options)
		assert.Equal(t, http.StatusOK, finishLogin(t, srv, body))
	}
}

// Anyone can call login/begin and each call parks a ceremony in a store that
// holds 100. One address cannot make enough calls in the ceremony's lifetime to
// push the owner's pending sign-in out, which is what the limit is for.
func TestAuthRateLimit_ScannerBeginningLogins_CannotEvictTheOwnersCeremony(t *testing.T) {
	t.Parallel()
	srv, _ := limitedServer(t, 10, 6*time.Second)
	rp := virtualwebauthn.RelyingParty{Name: "Forge Board Test", ID: testRPID, Origin: testOrigin}
	_, cred, authenticator := registerViaRealCeremony(t, srv)
	owners := beginLogin(t, srv)

	for range 300 {
		postFrom(t, srv, "/api/auth/login/begin", "203.0.113.50")
	}

	body := virtualwebauthn.CreateAssertionResponse(rp, authenticator, cred, *owners)
	assert.Equal(t, http.StatusOK, finishLogin(t, srv, body))
}
