package api_test

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The user's own issue settings (#1630) are applied by the server, so the
// board, the nav pill and Insights agree with no client arithmetic.

func settingsIssues() []dashboard.Issue {
	gh := func(n int, title string) dashboard.Issue {
		return dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: n, Title: title}
	}
	dep := gh(1, "Dependency Dashboard")
	dep.Author = "renovate[bot]"

	return []dashboard.Issue{
		dep,
		gh(2, "A real bug"),
		gh(3, "Weekly report for May"),
		gh(4, "Please see the WEEKLY REPORT"),
		gh(5, "Another real bug"),
	}
}

// issueSettingsServer is a server whose first user has the issues above, once
// the board shows all five.
func issueSettingsServer(t *testing.T) (*httptest.Server, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		issues: settingsIssues(),
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+token+`"}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool {
		issues, _ := fetchDashboard(t, srv.URL, cookie)["issues"].([]any)

		return len(issues) == 5
	}, pollBudget, 10*time.Millisecond)

	return srv, cookie
}

func issueNumbers(board map[string]any) []int {
	var out []int
	for _, raw := range board["issues"].([]any) {
		out = append(out, int(raw.(map[string]any)["number"].(float64)))
	}

	return out
}

func navIssueTotal(board map[string]any) float64 {
	return board["navCounts"].(map[string]any)["issues"].(map[string]any)["total"].(float64)
}

func TestDashboard_WithNoIssueSettings_ListsEveryIssueAndHidesNone(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, []int{1, 2, 3, 4, 5}, issueNumbers(board))
	assert.InDelta(t, 0, board["settingsHiddenIssueCount"], 0, "present and zero")
}

func TestDashboard_HideDependencyDashboard_LeavesOutTheHousekeepingIssue(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true}`, cookie)
	require.Equal(t, http.StatusOK, status)

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, []int{2, 3, 4, 5}, issueNumbers(board))
	assert.InDelta(t, 1, board["settingsHiddenIssueCount"], 0)
}

func TestDashboard_IgnoredTitles_LeaveOutMatchesAnywhereIgnoringCase(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"ignoredTitles":["weekly report"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, []int{1, 2, 5}, issueNumbers(board), "3 matches at the start, 4 in the middle in capitals")
	assert.InDelta(t, 2, board["settingsHiddenIssueCount"], 0)
}

func TestDashboard_IgnoredTitles_AnchorsAreHonoured(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"ignoredTitles":["^Weekly report"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	assert.Equal(t, []int{1, 2, 4, 5}, issueNumbers(fetchDashboard(t, srv.URL, cookie)))
}

func TestDashboard_BothSettings_CountAnIssueTheyBothMatchOnce(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["dependency","bug"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, []int{3, 4}, issueNumbers(board))
	assert.InDelta(t, 3, board["settingsHiddenIssueCount"], 0)
}

func TestDashboard_IssueCounts_FollowTheIssuesThatRemain(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	before := fetchDashboard(t, srv.URL, cookie)
	require.InDelta(t, 4, before["openIssueCount"], 0, "the housekeeping issue was never counted")
	require.InDelta(t, 4, navIssueTotal(before), 0)

	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["^Weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	after := fetchDashboard(t, srv.URL, cookie)

	assert.InDelta(t, 3, after["openIssueCount"], 0, "bug, capitals report, other bug")
	assert.InDelta(t, 3, navIssueTotal(after), 0)
}

func TestDashboard_IssueSettings_DoNotChangeAnotherUsersBoard(t *testing.T) {
	t.Parallel()
	srv, owner := issueSettingsServer(t)
	other := registerExtraUser(t, srv, testOtherUser, "Alex")
	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["bug"]}`, other)
	require.Equal(t, http.StatusOK, status)

	assert.Equal(t, []int{1, 2, 3, 4, 5}, issueNumbers(fetchDashboard(t, srv.URL, owner)))
}

func TestDashboardStream_AppliesTheIssueSettings(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["^Weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	webhookToken, webhookSecret := webhookCredentials(t, srv.URL, cookie)

	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard/stream", nil)
	require.NoError(t, err)
	req.AddCookie(cookie)
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	events := make(chan string, 4)
	go streamSSEEvents(bufio.NewReader(resp.Body), events)

	body := []byte(`{"action":"opened"}`)
	hook, err := http.NewRequest(http.MethodPost, srv.URL+"/api/webhooks/github/"+webhookToken, strings.NewReader(string(body)))
	require.NoError(t, err)
	hook.Header.Set("X-Hub-Signature-256", "sha256="+hexHMAC(body, webhookSecret))
	hookResp, err := testClient(t).Do(hook)
	require.NoError(t, err)
	_ = hookResp.Body.Close()
	require.Equal(t, http.StatusNoContent, hookResp.StatusCode)

	select {
	case data := <-events:
		var board map[string]any
		require.NoError(t, json.Unmarshal([]byte(data), &board))
		assert.Equal(t, []int{2, 4, 5}, issueNumbers(board))
		assert.InDelta(t, 2, board["settingsHiddenIssueCount"], 0)
		assert.InDelta(t, 3, navIssueTotal(board), 0)
		assert.Equal(t, true, board["hideDependencyDashboard"])
		assert.Equal(t, true, board["ignoredTitlesSet"])
	case <-time.After(pollBudget):
		t.Fatal("no SSE event received after the webhook-triggered refresh")
	}
}

func TestMCP_GetDashboard_AppliesTheIssueSettings(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)
	status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["^Weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	session := connectMCP(t, srv.URL, createAPIToken(t, srv.URL, cookie))

	result, err := session.CallTool(t.Context(), &mcp.CallToolParams{Name: "get_dashboard"})
	require.NoError(t, err)
	require.False(t, result.IsError)
	board, ok := result.StructuredContent.(map[string]any)
	require.True(t, ok)

	assert.Equal(t, []int{2, 4, 5}, issueNumbers(board))
	assert.InDelta(t, 2, board["settingsHiddenIssueCount"], 0)
	assert.InDelta(t, 3, board["openIssueCount"], 0)
	assert.Equal(t, true, board["hideDependencyDashboard"])
	assert.Equal(t, true, board["ignoredTitlesSet"])
}

// An issue from a repo the user ignored is not on their board either way, so
// the settings did not hide it: it must not be in settingsHiddenIssueCount.
func TestDashboard_IssuesOfAnIgnoredRepo_AreNotCountedAsHiddenBySettings(t *testing.T) {
	t.Parallel()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	gh := func(repo string, n int, title string) dashboard.Issue {
		return dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: repo, Number: n, Title: title}
	}
	dep := gh("alrayyes/ignored", 1, "Dependency Dashboard")
	dep.Author = "renovate[bot]"
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2},
		issues: []dashboard.Issue{dep, gh("alrayyes/ignored", 2, "Weekly report"), gh("alrayyes/kept", 3, "Weekly report"), gh("alrayyes/kept", 4, "A bug")},
		repos: []dashboard.Repo{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/ignored", URL: "https://github.com/alrayyes/ignored"},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/kept", URL: "https://github.com/alrayyes/kept"},
		},
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+token+`","hideDependencyDashboard":true,"ignoredTitles":["^Weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool {
		repos, _ := fetchDashboard(t, srv.URL, cookie)["repos"].([]any)

		return len(repos) == 2
	}, pollBudget, 10*time.Millisecond)
	ignore := postRepoIgnoreAction(t, srv.URL, cookie, "alrayyes/ignored", false, true)
	_ = ignore.Body.Close()
	require.Equal(t, http.StatusNoContent, ignore.StatusCode)

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Equal(t, []int{4}, issueNumbers(board))
	assert.InDelta(t, 1, board["settingsHiddenIssueCount"], 0, "only the kept repo's Weekly report")
}

// The dashboard carries the two flags so a client needn't read
// GET /api/settings, which also holds the webhook secret, just to know whether
// to draw its two fields.
func TestDashboard_CarriesTheIssueSettingFlags(t *testing.T) {
	t.Parallel()
	srv, cookie := issueSettingsServer(t)

	t.Run("both off by default and present", func(t *testing.T) {
		board := fetchDashboard(t, srv.URL, cookie)

		assert.Equal(t, false, board["hideDependencyDashboard"])
		assert.Equal(t, false, board["ignoredTitlesSet"])
	})
	t.Run("both on once saved, even when a pattern matches nothing", func(t *testing.T) {
		status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["matches nothing here"]}`, cookie)
		require.Equal(t, http.StatusOK, status)

		board := fetchDashboard(t, srv.URL, cookie)

		assert.Equal(t, true, board["hideDependencyDashboard"])
		assert.Equal(t, true, board["ignoredTitlesSet"])
		assert.InDelta(t, 1, board["settingsHiddenIssueCount"], 0, "only the Dependency Dashboard: the pattern matched nothing")
	})
	t.Run("a cleared list turns ignoredTitlesSet off", func(t *testing.T) {
		status, _ := putSettings(t, srv.URL, `{"hideDependencyDashboard":true,"ignoredTitles":["  "]}`, cookie)
		require.Equal(t, http.StatusOK, status)

		board := fetchDashboard(t, srv.URL, cookie)

		assert.Equal(t, true, board["hideDependencyDashboard"])
		assert.Equal(t, false, board["ignoredTitlesSet"])
	})
}
