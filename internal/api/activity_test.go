package api_test

import (
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// apiClock is a clock a test moves by hand.
type apiClock struct {
	mu sync.Mutex
	t  time.Time
}

func newAPIClock() *apiClock {
	return &apiClock{t: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)}
}

func (c *apiClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.t
}

func (c *apiClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// idleActivity is an Activity that has been left alone past its idle period,
// wired into manager.
func idleActivity(t *testing.T, manager *dashboard.Manager) *dashboard.Activity {
	t.Helper()

	clock := newAPIClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	manager.SetActivity(act)
	clock.advance(time.Hour)
	require.True(t, act.Idle())

	return act
}

func TestActivity_ASignedInRequestCountsAsUse(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	act := idleActivity(t, manager)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/auth/session", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.False(t, act.Idle())
}

func TestActivity_ARequestThatIsRejectedIsNotUse(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	act := idleActivity(t, manager)

	resp, err := http.Get(srv.URL + "/api/auth/session")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusUnauthorized, resp.StatusCode)

	assert.True(t, act.Idle(), "a request with no valid sign-in must not keep the refresh running")
}

func TestActivity_AHealthProbeIsNotUse(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	act := idleActivity(t, manager)

	resp, err := http.Get(srv.URL + "/healthz")
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.True(t, act.Idle(), "the container's probe hits this all day")
}

func TestActivity_AnOpenLiveStreamAloneIsNotUse(t *testing.T) {
	t.Parallel()

	srv, manager, authStore := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	user, err := authStore.UserForSession(t.Context(), cookie.Value)
	require.NoError(t, err)
	manager.EnsureIfAbsent(t.Context(), user.ID, nil)
	act := idleActivity(t, manager)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.True(t, act.Idle(), "a stream in a tab nobody is looking at must not keep the refresh running")
}
