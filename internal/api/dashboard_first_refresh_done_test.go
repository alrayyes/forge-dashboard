package api_test

import (
	"bufio"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// holdSource blocks Fetch until release is closed, so a test can hold a
// user's first refresh open.
type holdSource struct {
	release   chan struct{}
	reachable bool
}

func (s *holdSource) Fetch(ctx context.Context) dashboard.Result {
	select {
	case <-s.release:
	case <-ctx.Done():
	}

	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: s.reachable}}
}

func (s *holdSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

const firstRefreshToken = "first-refresh-token" // #nosec G101 -- a fake test fixture, not a real credential

// firstRefreshServer serves a source for the token, held open until release is
// closed. Reads wait only briefly for the first refresh, so a read during the
// hold comes back with the flag still false.
func firstRefreshServer(t *testing.T, src dashboard.Source) (url string, cookie *http.Cookie, apiToken string) {
	t.Helper()

	srv, _, _ := newTestServerWithFirstLoadWait(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != firstRefreshToken {
			return nil
		}

		return []dashboard.Source{src}
	}, false, 50*time.Millisecond)
	cookie, _, _ = registerViaRealCeremony(t, srv, testUser, testDisplay)
	apiToken = createAPIToken(t, srv.URL, cookie)
	put := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+firstRefreshToken+`"}`, cookie)
	_ = put.Body.Close()
	require.Equal(t, http.StatusOK, put.StatusCode)

	return srv.URL, cookie, apiToken
}

func firstRefreshDoneOverHTTP(t *testing.T, url string, cookie *http.Cookie) any {
	t.Helper()

	body := fetchDashboardWith(t, url, cookie, "")
	v, present := body["firstRefreshDone"]
	require.True(t, present, "firstRefreshDone is required on the snapshot, so it is always there")

	return v
}

func firstRefreshDoneOverMCP(t *testing.T, url, token string) any {
	t.Helper()

	session := connectMCP(t, url, token)
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_dashboard"})
	require.NoError(t, err)
	require.False(t, result.IsError)
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)
	v, present := content["firstRefreshDone"]
	require.True(t, present, "get_dashboard carries firstRefreshDone")

	return v
}

func TestDashboard_FirstRefreshDone_FalseWhileTheFirstRefreshRuns_OnHTTPAndMCP(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{})}
	url, cookie, apiToken := firstRefreshServer(t, src)
	t.Cleanup(func() { close(src.release) })

	assert.Equal(t, false, firstRefreshDoneOverHTTP(t, url, cookie))
	assert.Equal(t, false, firstRefreshDoneOverMCP(t, url, apiToken))
}

func TestDashboard_FirstRefreshDone_TrueOnceTheFirstRefreshSucceeds_AndStaysTrue(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{}), reachable: true}
	url, cookie, apiToken := firstRefreshServer(t, src)

	require.Equal(t, false, firstRefreshDoneOverHTTP(t, url, cookie))
	close(src.release)

	require.Eventually(t, func() bool { return firstRefreshDoneOverHTTP(t, url, cookie) == true }, 2*time.Second, 10*time.Millisecond)
	// Later refreshes (the test manager ticks every few milliseconds) keep it.
	time.Sleep(50 * time.Millisecond)
	assert.Equal(t, true, firstRefreshDoneOverHTTP(t, url, cookie))
	assert.Equal(t, true, firstRefreshDoneOverMCP(t, url, apiToken))
}

func TestDashboard_FirstRefreshDone_TrueWhenTheFirstRefreshFails(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{}), reachable: false}
	url, cookie, _ := firstRefreshServer(t, src)
	close(src.release)

	require.Eventually(t, func() bool { return firstRefreshDoneOverHTTP(t, url, cookie) == true }, 2*time.Second, 10*time.Millisecond)
	body := fetchDashboardWith(t, url, cookie, "")
	forges, _ := body["forges"].([]any)
	require.Len(t, forges, 1, "the failure is carried by forge health")
	assert.Equal(t, false, forges[0].(map[string]any)["reachable"])
}

func TestDashboard_FirstRefreshDone_IsPerViewer(t *testing.T) {
	t.Parallel()

	const slowToken = "slow-token" // #nosec G101 -- a fake test fixture, not a real credential
	slow := &holdSource{release: make(chan struct{})}
	t.Cleanup(func() { close(slow.release) })
	srv, _, _ := newTestServerWithFirstLoadWait(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		switch c.GitHubToken {
		case firstRefreshToken:
			return []dashboard.Source{&holdSource{release: closedChan(), reachable: true}}
		case slowToken:
			return []dashboard.Source{slow}
		}

		return nil
	}, false, 50*time.Millisecond)
	cookieA, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	invite := createInviteViaAdmin(t, srv, cookieA, testOtherUser, "Alex")
	cookieB, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", invite)
	for cookie, token := range map[*http.Cookie]string{cookieA: firstRefreshToken, cookieB: slowToken} {
		put := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
		_ = put.Body.Close()
		require.Equal(t, http.StatusOK, put.StatusCode)
	}

	require.Eventually(t, func() bool { return firstRefreshDoneOverHTTP(t, srv.URL, cookieA) == true }, 2*time.Second, 10*time.Millisecond)
	assert.Equal(t, false, firstRefreshDoneOverHTTP(t, srv.URL, cookieB), "the other viewer's refresh is still running")
}

func closedChan() chan struct{} {
	c := make(chan struct{})
	close(c)

	return c
}

func TestDashboardStream_CarriesFirstRefreshDone(t *testing.T) {
	t.Parallel()

	srvURL, _, sessionCookie := newTestServerWithCountingSource(t)
	webhookToken, webhookSecret := webhookCredentials(t, srvURL, sessionCookie)

	streamReq, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	streamReq.AddCookie(sessionCookie)
	streamResp, err := http.DefaultClient.Do(streamReq)
	require.NoError(t, err)
	defer func() { _ = streamResp.Body.Close() }()
	events := make(chan string, 4)
	go streamSSEEvents(bufio.NewReader(streamResp.Body), events)

	body := []byte(`{"action":"opened"}`)
	webhookReq, err := http.NewRequest(http.MethodPost, srvURL+"/api/webhooks/github/"+webhookToken, strings.NewReader(string(body)))
	require.NoError(t, err)
	webhookReq.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, webhookSecret))
	webhookResp, err := http.DefaultClient.Do(webhookReq)
	require.NoError(t, err)
	_ = webhookResp.Body.Close()

	select {
	case data := <-events:
		assert.Contains(t, data, `"firstRefreshDone":true`)
	case <-time.After(2 * time.Second):
		t.Fatal("no SSE event received")
	}
}

// A viewer with no saved settings has no Aggregator and nothing to refresh, so
// no first refresh will ever end. The flag must not stay false for them.
func TestDashboard_FirstRefreshDone_TrueForAViewerWithNoSavedSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	apiToken := createAPIToken(t, srv.URL, cookie)

	assert.Equal(t, true, firstRefreshDoneOverHTTP(t, srv.URL, cookie))
	assert.Equal(t, true, firstRefreshDoneOverMCP(t, srv.URL, apiToken))
}

// Saving settings rebuilds the Aggregator, and its first refresh is pending
// again. The viewer has been served already, so the flag must stay true.
func TestDashboard_FirstRefreshDone_StaysTrueAcrossASettingsSaveRebuild(t *testing.T) {
	t.Parallel()

	const heldToken = "held-token" // #nosec G101 -- a fake test fixture, not a real credential
	held := &holdSource{release: make(chan struct{})}
	t.Cleanup(func() { close(held.release) })
	srv, _, _ := newTestServerWithFirstLoadWait(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		switch c.GitHubToken {
		case firstRefreshToken:
			return []dashboard.Source{&holdSource{release: closedChan(), reachable: true}}
		case heldToken:
			return []dashboard.Source{held}
		}

		return nil
	}, false, 50*time.Millisecond)
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	save := func(token string) {
		put := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
		_ = put.Body.Close()
		require.Equal(t, http.StatusOK, put.StatusCode)
	}

	save(firstRefreshToken)
	// Let the first refresh end without reading the flag: a read would record
	// the mark itself, and the rebuild has to carry it on its own. Main branches
	// waits for the first refresh and never touches the flag.
	for range 3 {
		resp := doJSON(t, http.MethodGet, srv.URL+"/api/main-branches", "", cookie)
		_ = resp.Body.Close()
		time.Sleep(30 * time.Millisecond)
	}

	save(heldToken)

	assert.Equal(t, true, firstRefreshDoneOverHTTP(t, srv.URL, cookie), "the rebuilt Aggregator's pending refresh must not bring the loading state back")
}
