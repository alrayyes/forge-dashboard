package api_test

import (
	"context"
	"encoding/json"
	"maps"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A hidden pull request leaves the board and the counts, comes back on
// Restore, and is forgotten once it closes (#841).

// hideSource is a source whose open pull requests and health a test changes
// while the server runs, the way a merge or an outage changes them.
type hideSource struct {
	mu        sync.Mutex
	reachable bool
	numbers   []int
}

const hideRepo = "alrayyes/forge-dashboard"

func (s *hideSource) set(reachable bool, numbers ...int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reachable = reachable
	s.numbers = numbers
}

func (s *hideSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func (s *hideSource) Fetch(_ context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	prs := make([]dashboard.PullRequest, 0, len(s.numbers))
	for _, n := range s.numbers {
		prs = append(prs, dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: hideRepo, Number: n,
			Title: "Pull request", MergeStatus: dashboard.MergeUnknown,
		})
	}

	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: s.reachable, RepoCount: 1},
		PullRequests: prs,
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: hideRepo}},
	}
}

// newHideServer signs a user in with GitHub credentials and waits for the
// board to show pull requests 1 and 2.
func newHideServer(t *testing.T) (srvURL string, cookie *http.Cookie, src *hideSource) {
	t.Helper()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src = &hideSource{}
	src.set(true, 1, 2)
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != secretToken {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ = registerViaRealCeremony(t, srv, testUser, testDisplay)

	req, err := http.NewRequest(http.MethodPut, srv.URL+"/api/settings", strings.NewReader(`{"githubToken":"`+secretToken+`"}`))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		return len(boardNumbers(t, srv.URL, cookie, "")) == 2
	}, 2*time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture pull requests")

	return srv.URL, cookie, src
}

func postHide(t *testing.T, srvURL string, cookie *http.Cookie, path string, body map[string]any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(body)
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+path, strings.NewReader(string(raw)))
	require.NoError(t, err)
	if cookie != nil {
		req.AddCookie(cookie)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

// hide hides pull request 1, with extra fields (like days) in the body.
func hide(t *testing.T, srvURL string, cookie *http.Cookie, extra map[string]any) {
	t.Helper()
	body := map[string]any{"forge": "github", "fullName": hideRepo, "number": 1}
	maps.Copy(body, extra)
	resp := postHide(t, srvURL, cookie, "/api/pull-requests/hide", body)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

// boardNumbers is the pull request numbers GET /api/dashboard lists.
func boardNumbers(t *testing.T, srvURL string, cookie *http.Cookie, query string) []int {
	t.Helper()
	prs, _ := fetchDashboardWith(t, srvURL, cookie, query)["pullRequests"].([]any)
	numbers := make([]int, 0, len(prs))
	for _, pr := range prs {
		numbers = append(numbers, int(pr.(map[string]any)["number"].(float64)))
	}

	return numbers
}

func hiddenCount(t *testing.T, srvURL string, cookie *http.Cookie) int {
	t.Helper()
	body := fetchDashboardWith(t, srvURL, cookie, "")
	require.Contains(t, body, "hiddenPullRequests", "the count is always present")

	return int(body["hiddenPullRequests"].(float64))
}

func TestPullRequestHide_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	for _, path := range []string{"/api/pull-requests/hide", "/api/pull-requests/unhide"} {
		resp := postHide(t, srv.URL, nil, path, map[string]any{"forge": "github", "fullName": hideRepo, "number": 1})
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, path)
	}
}

func TestPullRequestHide_RejectsABadBody(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	for name, body := range map[string]map[string]any{
		"a full name that isn't owner/repo": {"forge": "github", "fullName": "nope", "number": 1},
		"a number that isn't positive":      {"forge": "github", "fullName": hideRepo, "number": 0},
		"days below 1":                      {"forge": "github", "fullName": hideRepo, "number": 1, "days": 0},
		"days above 365":                    {"forge": "github", "fullName": hideRepo, "number": 1, "days": 366},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := postHide(t, srvURL, cookie, "/api/pull-requests/hide", body)
			_ = resp.Body.Close()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
}

func TestPullRequestHide_TakesItOffTheBoard(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	assert.Equal(t, []int{2}, boardNumbers(t, srvURL, cookie, ""))
}

func TestPullRequestHide_CountsIt(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	assert.Equal(t, 1, hiddenCount(t, srvURL, cookie))
}

func TestPullRequestHide_NothingHiddenCountsZero(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)

	assert.Equal(t, 0, hiddenCount(t, srvURL, cookie))
}

func TestPullRequestHide_IncludeHiddenListsItMarkedHidden(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	prs := fetchDashboardWith(t, srvURL, cookie, "?includeHidden=true")["pullRequests"].([]any)
	marked := map[int]any{}
	for _, pr := range prs {
		m := pr.(map[string]any)
		marked[int(m["number"].(float64))] = m["hidden"]
	}

	assert.Equal(t, map[int]any{1: true, 2: nil}, marked)
}

func TestPullRequestHide_UntilRestoredHasNoEndTime(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	prs := fetchDashboardWith(t, srvURL, cookie, "?includeHidden=true")["pullRequests"].([]any)
	for _, pr := range prs {
		m := pr.(map[string]any)
		if int(m["number"].(float64)) == 1 {
			assert.NotContains(t, m, "hiddenUntil")
		}
	}
}

func TestPullRequestHide_ForDaysSaysWhenItEnds(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, map[string]any{"days": 7})

	var until time.Time
	for _, pr := range fetchDashboardWith(t, srvURL, cookie, "?includeHidden=true")["pullRequests"].([]any) {
		m := pr.(map[string]any)
		if int(m["number"].(float64)) == 1 {
			parsed, err := time.Parse(time.RFC3339, m["hiddenUntil"].(string))
			require.NoError(t, err)
			until = parsed
		}
	}

	assert.WithinDuration(t, time.Now().Add(7*24*time.Hour), until, time.Minute)
}

func TestPullRequestUnhide_BringsItBack(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	resp := postHide(t, srvURL, cookie, "/api/pull-requests/unhide", map[string]any{"forge": "github", "fullName": hideRepo, "number": 1})
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	assert.ElementsMatch(t, []int{1, 2}, boardNumbers(t, srvURL, cookie, ""))
}

func TestPullRequestUnhide_NotHiddenIsStillA204(t *testing.T) {
	t.Parallel()

	srvURL, cookie, _ := newHideServer(t)

	resp := postHide(t, srvURL, cookie, "/api/pull-requests/unhide", map[string]any{"forge": "github", "fullName": hideRepo, "number": 1})
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestPullRequestHide_IsForgottenOnceThePullRequestCloses(t *testing.T) {
	t.Parallel()

	srvURL, cookie, src := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	// #1 merges. The next snapshot no longer has it, so the record goes.
	src.set(true, 2)
	require.Eventually(t, func() bool { return hiddenCount(t, srvURL, cookie) == 0 }, 2*time.Second, 10*time.Millisecond)

	// A reopened #1 is a new pull request to the board: it shows.
	src.set(true, 1, 2)
	require.Eventually(t, func() bool {
		return len(boardNumbers(t, srvURL, cookie, "")) == 2
	}, 2*time.Second, 10*time.Millisecond)
}

func TestPullRequestHide_IsKeptWhileItsForgeIsUnreachable(t *testing.T) {
	t.Parallel()

	srvURL, cookie, src := newHideServer(t)
	hide(t, srvURL, cookie, nil)

	// An outage returns no pull requests; that isn't a close.
	src.set(false)
	time.Sleep(200 * time.Millisecond)
	src.set(true, 1, 2)

	require.Eventually(t, func() bool { return len(boardNumbers(t, srvURL, cookie, "?includeHidden=true")) == 2 }, 2*time.Second, 10*time.Millisecond)
	assert.Equal(t, 1, hiddenCount(t, srvURL, cookie))
}
