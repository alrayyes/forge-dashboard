package api_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// draftsServer serves a signed-in user two ready pull requests and one draft,
// once the background refresh has picked them up (#791).
func draftsServer(t *testing.T) (srvURL string, sessionCookie *http.Cookie) {
	t.Helper()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Draft: true},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3},
		},
	}
	buildSources := func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{source}
	}

	srv := newTestServerWithSources(t, buildSources)
	sessionCookie, _, _ = registerViaRealCeremony(t, srv, testUser, testDisplay)

	putReq, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	putReq.AddCookie(sessionCookie)
	putReq.Header.Set("Content-Type", "application/json")
	putResp, err := http.DefaultClient.Do(putReq)
	require.NoError(t, err)
	_ = putResp.Body.Close()
	require.Equal(t, http.StatusOK, putResp.StatusCode)

	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, sessionCookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(prs) == 3
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture PRs")

	return srv.URL, sessionCookie
}

func fetchDashboardWith(t *testing.T, srvURL string, sessionCookie *http.Cookie, query string) map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard"+query, nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

	return body
}

func prNumbers(t *testing.T, snap map[string]any) []float64 {
	t.Helper()
	prs, ok := snap["pullRequests"].([]any)
	require.True(t, ok)
	out := make([]float64, 0, len(prs))
	for _, p := range prs {
		out = append(out, p.(map[string]any)["number"].(float64))
	}

	return out
}

func TestDashboard_Drafts(t *testing.T) {
	t.Parallel()

	t.Run("are left out by default and counted", func(t *testing.T) {
		t.Parallel()
		srvURL, cookie := draftsServer(t)

		snap := fetchDashboardWith(t, srvURL, cookie, "")

		assert.Equal(t, []float64{1, 3}, prNumbers(t, snap))
		assert.InDelta(t, 1, snap["hiddenDrafts"], 0)
	})

	t.Run("are included on request, with none hidden", func(t *testing.T) {
		t.Parallel()
		srvURL, cookie := draftsServer(t)

		snap := fetchDashboardWith(t, srvURL, cookie, "?includeDrafts=true")

		assert.Equal(t, []float64{1, 2, 3}, prNumbers(t, snap))
		assert.InDelta(t, 0, snap["hiddenDrafts"], 0, "hiddenDrafts is present and zero, never absent")
	})

	t.Run("are left out of the refresh response by default", func(t *testing.T) {
		t.Parallel()
		srvURL, cookie := draftsServer(t)

		req, err := http.NewRequest(http.MethodPost, srvURL+"/api/dashboard/refresh", nil)
		require.NoError(t, err)
		req.AddCookie(cookie)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		var snap map[string]any
		require.NoError(t, json.NewDecoder(resp.Body).Decode(&snap))

		assert.Equal(t, []float64{1, 3}, prNumbers(t, snap))
		assert.InDelta(t, 1, snap["hiddenDrafts"], 0)
	})

	t.Run("follow the includeDrafts the stream was opened with", func(t *testing.T) {
		t.Parallel()
		srvURL, cookie := draftsServer(t)

		streamReq, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard/stream?includeDrafts=true", nil)
		require.NoError(t, err)
		streamReq.AddCookie(cookie)
		streamResp, err := http.DefaultClient.Do(streamReq)
		require.NoError(t, err)
		defer func() { _ = streamResp.Body.Close() }()
		require.Equal(t, http.StatusOK, streamResp.StatusCode)
		events := make(chan string, 4)
		go streamSSEEvents(bufio.NewReader(streamResp.Body), events)

		refreshReq, err := http.NewRequest(http.MethodPost, srvURL+"/api/dashboard/refresh", nil)
		require.NoError(t, err)
		refreshReq.AddCookie(cookie)
		refreshResp, err := http.DefaultClient.Do(refreshReq)
		require.NoError(t, err)
		_ = refreshResp.Body.Close()

		select {
		case data, ok := <-events:
			require.True(t, ok, "SSE stream closed before any event arrived")
			var snap map[string]any
			require.NoError(t, json.Unmarshal([]byte(data), &snap))
			assert.Equal(t, []float64{1, 2, 3}, prNumbers(t, snap))
			assert.InDelta(t, 0, snap["hiddenDrafts"], 0)
		case <-time.After(2 * time.Second):
			t.Fatal("no SSE event received after the refresh")
		}
	})
}
