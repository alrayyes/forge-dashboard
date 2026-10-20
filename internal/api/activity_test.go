package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
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

// postPresence sends one presence report and returns the status and body.
func postPresence(t *testing.T, srvURL string, cookie *http.Cookie, body string) (int, []byte) {
	t.Helper()

	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/dashboard/presence", strings.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	return resp.StatusCode, raw
}

func TestPresence_RequiresASession(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	act := idleActivity(t, manager)

	status, _ := postPresence(t, srv.URL, nil, `{"viewerId":"tab-aaaaaaaa","visible":true}`)

	assert.Equal(t, http.StatusUnauthorized, status)
	assert.True(t, act.Idle())
}

func TestPresence_VisibleHoldsTheDashboardActiveAndAnswersTheTimings(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	act := idleActivity(t, manager)

	status, raw := postPresence(t, srv.URL, cookie, `{"viewerId":"tab-aaaaaaaa","visible":true}`)

	require.Equal(t, http.StatusOK, status)
	var body struct {
		HeartbeatSeconds int `json:"heartbeatSeconds"`
		IdleAfterSeconds int `json:"idleAfterSeconds"`
	}
	require.NoError(t, json.Unmarshal(raw, &body))
	assert.Equal(t, 60, body.HeartbeatSeconds)
	assert.Equal(t, 900, body.IdleAfterSeconds)
	assert.False(t, act.Idle())
	select {
	case <-act.Woken():
	default:
		t.Fatal("the first visible report after idle should wake the refresh")
	}
}

func TestPresence_HiddenIsNotUseAndLetsTheTabGo(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	clock := newAPIClock()
	act := dashboard.NewActivity(15*time.Minute, clock.now)
	manager.SetActivity(act)

	status, _ := postPresence(t, srv.URL, cookie, `{"viewerId":"tab-aaaaaaaa","visible":true}`)
	require.Equal(t, http.StatusOK, status)
	clock.advance(time.Hour)
	status, _ = postPresence(t, srv.URL, cookie, `{"viewerId":"tab-aaaaaaaa","visible":false}`)
	require.Equal(t, http.StatusOK, status)
	clock.advance(16 * time.Minute)

	assert.True(t, act.Idle(), "the hidden report itself is not a request that counts as use")
}

func TestPresence_RejectsABodyItCannotUse(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	act := idleActivity(t, manager)

	for _, body := range []string{``, `{`, `{"visible":true}`, `{"viewerId":"x","visible":true}`, `{"viewerId":"tab-aaaaaaaa"}`} {
		status, _ := postPresence(t, srv.URL, cookie, body)
		assert.Equal(t, http.StatusBadRequest, status, body)
	}
	assert.True(t, act.Idle())
}

func TestActivity_ABackgroundReadIsNotUse(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	act := idleActivity(t, manager)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("X-Background-Read", "true")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	assert.True(t, act.Idle(), "the page's own poll in a hidden or unattended tab is not use")
}

func TestPresence_APersonalAPITokenIsRefusedAndHoldsNothingActive(t *testing.T) {
	t.Parallel()

	srv, manager, _ := newTestServerWithSourcesAndManager(t, noSources)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	token := createTestAPIToken(t, srv.URL, cookie)
	act := idleActivity(t, manager)

	resp := doWithBearer(t, http.MethodPost, srv.URL+"/api/dashboard/presence", `{"viewerId":"tab-aaaaaaaa","visible":true}`, token)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
	assert.True(t, act.Idle(), "a script has no tab to report")
}
