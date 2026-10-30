package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func readIntervalOverHTTP(t *testing.T, url string, cookie *http.Cookie) any {
	t.Helper()

	return fetchDashboardWith(t, url, cookie, "")["readIntervalSeconds"]
}

// Until the viewer's first refresh has finished the page is showing a loading
// state, so it is told to ask again soon.
func TestDashboard_ReadInterval_ShortWhileTheFirstRefreshRuns(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{})}
	url, cookie, _ := firstRefreshServer(t, src)
	t.Cleanup(func() { close(src.release) })

	assert.InDelta(t, 2, readIntervalOverHTTP(t, url, cookie), 0)
}

func TestDashboard_ReadInterval_ShortWhileTheFirstRefreshRuns_OnMCP(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{})}
	url, _, apiToken := firstRefreshServer(t, src)
	t.Cleanup(func() { close(src.release) })

	session := connectMCP(t, url, apiToken)
	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_dashboard"})
	require.NoError(t, err)
	content, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)

	assert.InDelta(t, 2, content["readIntervalSeconds"], 0)
}

func TestDashboard_ReadInterval_NormalOnceTheFirstRefreshHasFinished(t *testing.T) {
	t.Parallel()

	src := &holdSource{release: make(chan struct{}), reachable: true}
	url, cookie, _ := firstRefreshServer(t, src)
	require.InDelta(t, 2, readIntervalOverHTTP(t, url, cookie), 0)
	close(src.release)

	require.Eventually(t, func() bool { return readIntervalOverHTTP(t, url, cookie) == float64(30) },
		pollBudget, 10*time.Millisecond)
}

// Nothing refreshes for a viewer with no saved settings, so the flag is true
// at once and the page is not asked to hurry.
func TestDashboard_ReadInterval_NormalForAViewerWithNoSavedSettings(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	cookie, _, _ := registerViaRealCeremony(t, srv)

	assert.InDelta(t, 30, readIntervalOverHTTP(t, srv.URL, cookie), 0)
}

// A read held for the first refresh ends when the refresh does, not when the
// wait runs out, and answers with the normal interval.
func TestDashboard_ReadInterval_HeldReadEndsOnCompletionNotTimeout(t *testing.T) {
	t.Parallel()

	const wait = 30 * time.Second
	src := &holdSource{release: make(chan struct{}), reachable: true}
	srv, _, _ := newTestServerWithFirstLoadWait(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != firstRefreshToken {
			return nil
		}

		return []dashboard.Source{src}
	}, false, wait)
	cookie, _, _ := registerViaRealCeremony(t, srv)
	put := doJSON(t, http.MethodPut, srv.URL+"/api/v1/settings", `{"githubToken":"`+firstRefreshToken+`"}`, cookie)
	_ = put.Body.Close()
	require.Equal(t, http.StatusOK, put.StatusCode)

	type answer struct {
		body    map[string]any
		elapsed time.Duration
		err     error
	}
	answered := make(chan answer, 1)
	start := time.Now()
	go func() {
		var a answer
		req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, srv.URL+"/api/v1/dashboard", nil)
		if err == nil {
			req.AddCookie(cookie)

			var resp *http.Response
			if resp, err = testClient(t).Do(req); err == nil {
				defer func() { _ = resp.Body.Close() }()
				err = json.NewDecoder(resp.Body).Decode(&a.body)
			}
		}
		a.err = err
		a.elapsed = time.Since(start)
		answered <- a
	}()

	select {
	case <-answered:
		t.Fatal("the read answered before the first refresh finished")
	case <-time.After(200 * time.Millisecond):
	}
	close(src.release)

	select {
	case got := <-answered:
		require.NoError(t, got.err)
		assert.Less(t, got.elapsed, wait/2, "the hold ends on completion, not on timeout")
		assert.Equal(t, true, got.body["firstRefreshDone"])
		assert.InDelta(t, 30, got.body["readIntervalSeconds"], 0)
	case <-time.After(wait / 2):
		t.Fatal("the held read did not end when the first refresh finished")
	}
}
