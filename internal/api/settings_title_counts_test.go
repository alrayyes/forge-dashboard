package api_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ignoredTitleCounts (#1677) says, per saved pattern, how many of the
// viewer's open issues it matches on its own.

const countsToken = "counts-token" // #nosec G101 -- a fake test fixture, not a real credential

func countIssue(n int, repo, title string) dashboard.Issue {
	return dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: repo, Number: n, Title: title}
}

// countsServer is a server whose users get the issues their GitHub token maps
// to in byToken, and registers the first user.
func countsServer(t *testing.T, byToken map[string][]dashboard.Issue) *httptest.Server {
	t.Helper()

	return newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		issues, ok := byToken[c.GitHubToken]
		if !ok {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{
			health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
			issues: issues,
		}}
	})
}

// signInWithBoard registers a user, saves their token and waits for the board
// to hold want issues, so the viewer has a snapshot.
func signInWithBoard(t *testing.T, srv *httptest.Server, username, token string, want int, invite ...string) *http.Cookie {
	t.Helper()

	cookie, _, _ := registerViaRealCeremony(t, srv, username, username, invite...)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+token+`"}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool {
		issues, _ := fetchDashboard(t, srv.URL, cookie)["issues"].([]any)

		return len(issues) == want
	}, pollBudget, 10*time.Millisecond)

	return cookie
}

func TestSettingsGet_IgnoredTitleCounts_CountsEachPatternsOpenIssuesInOrder(t *testing.T) {
	t.Parallel()
	issues := []dashboard.Issue{
		countIssue(1, "a/x", "Weekly report 1"), countIssue(2, "a/x", "Weekly report 2"), countIssue(3, "a/x", "Weekly report 3"),
		countIssue(4, "a/x", "stale branch"),
		countIssue(5, "a/x", "A real bug"),
	}
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: issues})
	cookie := signInWithBoard(t, srv, "ryan", countsToken, 5)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["^weekly report","STALE","nothing matches"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool { return getSettings(t, srv.URL, cookie).IgnoredTitleCounts[0] != nil }, 2*time.Second, 10*time.Millisecond)

	got := getSettings(t, srv.URL, cookie)

	assert.Equal(t, []*int{new(3), new(1), new(0)}, got.IgnoredTitleCounts, "order and length follow ignoredTitles; 0 is a real count here")
}

func TestSettingsGet_IgnoredTitleCounts_AnIssueTwoPatternsMatchCountsForBoth(t *testing.T) {
	t.Parallel()
	issues := []dashboard.Issue{countIssue(1, "a/x", "Weekly stale report"), countIssue(2, "a/x", "Other")}
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: issues})
	cookie := signInWithBoard(t, srv, "ryan", countsToken, 2)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly","stale"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	var got []*int
	require.Eventually(t, func() bool {
		got = getSettings(t, srv.URL, cookie).IgnoredTitleCounts

		return got[0] != nil
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, []*int{new(1), new(1)}, got)
	assert.InDelta(t, 1, fetchDashboard(t, srv.URL, cookie)["settingsHiddenIssueCount"], 0, "one issue hidden, counted by both patterns")
}

func TestSettingsGet_IgnoredTitleCounts_LeavesOutIssuesOfIgnoredRepos(t *testing.T) {
	t.Parallel()
	issues := []dashboard.Issue{countIssue(1, "a/x", "Weekly one"), countIssue(2, "a/muted", "Weekly two")}
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: issues})
	cookie := signInWithBoard(t, srv, "ryan", countsToken, 2)
	resp := postRepoIgnoreAction(t, srv.URL, cookie, "a/muted", false, true)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	var got []*int
	require.Eventually(t, func() bool {
		got = getSettings(t, srv.URL, cookie).IgnoredTitleCounts

		return got[0] != nil
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, []*int{new(1)}, got, "the same issues settingsHiddenIssueCount works from")
}

// gatedSource blocks its first fetch until release is closed, so the viewer's
// first refresh stays unfinished.
type gatedSource struct {
	release chan struct{}
	issues  []dashboard.Issue
}

func (s *gatedSource) Fetch(ctx context.Context) dashboard.Result {
	select {
	case <-s.release:
	case <-ctx.Done():
	}

	return dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		Issues: s.issues,
	}
}

func (s *gatedSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func TestSettingsGet_IgnoredTitleCounts_AreNullUntilTheFirstRefreshFinishes(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	src := &gatedSource{release: release, issues: []dashboard.Issue{countIssue(1, "a/x", "Weekly one")}}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != countsToken {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	status, put := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly","stale"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	assert.Equal(t, []any{nil, nil}, put["ignoredTitleCounts"], "the save answers before any refresh: unknown, not 0")
	assert.Equal(t, []*int{nil, nil}, getSettings(t, srv.URL, cookie).IgnoredTitleCounts)

	close(release)
	require.Eventually(t, func() bool { return getSettings(t, srv.URL, cookie).IgnoredTitleCounts[0] != nil }, 2*time.Second, 10*time.Millisecond)
	assert.Equal(t, []*int{new(1), new(0)}, getSettings(t, srv.URL, cookie).IgnoredTitleCounts)
}

func TestSettingsGet_IgnoredTitleCounts_AreNullWithNoSnapshotAndEmptyWithNoPatterns(t *testing.T) {
	t.Parallel()
	srv, manager, _ := newTestServerWithSourcesAndManager(t, func([]byte, settingspkg.Credentials) []dashboard.Source { return nil })
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)

	status, _ := putSettings(t, srv.URL, `{"ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	manager.Stop() // a restart: the viewer has no snapshot until they refresh again
	assert.Equal(t, []*int{nil}, getSettings(t, srv.URL, cookie).IgnoredTitleCounts, "no snapshot")

	status, put := putSettings(t, srv.URL, `{}`, cookie)
	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, []any{}, put["ignoredTitleCounts"], "[] on the wire, never null")
}

func TestSettingsPut_IgnoredTitleCounts_FollowTheListJustSaved(t *testing.T) {
	t.Parallel()
	issues := []dashboard.Issue{
		countIssue(1, "a/x", "Weekly one"), countIssue(2, "a/x", "Weekly two"), countIssue(3, "a/x", "Stale one"),
	}
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: issues})
	cookie := signInWithBoard(t, srv, "ryan", countsToken, 3)

	_, first := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	assert.Equal(t, []any{float64(2)}, first["ignoredTitleCounts"])
	// The save restarted the refresh; wait for the new snapshot before the next.
	require.Eventually(t, func() bool { return getSettings(t, srv.URL, cookie).IgnoredTitleCounts[0] != nil }, 2*time.Second, 10*time.Millisecond)

	_, second := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["stale","weekly one","zzz"]}`, cookie)
	assert.Equal(t, []any{float64(1), float64(1), float64(0)}, second["ignoredTitleCounts"], "counted against the new patterns, not the old")
}

func TestSettingsGet_IgnoredTitleCounts_CountOnlyTheViewersOwnIssues(t *testing.T) {
	t.Parallel()
	srv := countsServer(t, map[string][]dashboard.Issue{
		"token-a": {countIssue(1, "a/x", "Weekly one")},
		"token-b": {countIssue(1, "b/y", "Weekly one"), countIssue(2, "b/y", "Weekly two"), countIssue(3, "b/y", "Weekly three")},
	})
	cookieA := signInWithBoard(t, srv, "alice", "token-a", 1)
	cookieB := signInWithBoard(t, srv, "bob", "token-b", 3, createInviteViaAdmin(t, srv, cookieA, "bob", "bob"))
	for _, c := range []struct {
		cookie *http.Cookie
		token  string
	}{{cookieA, "token-a"}, {cookieB, "token-b"}} {
		status, _ := putSettings(t, srv.URL, `{"githubToken":"`+c.token+`","ignoredTitles":["weekly"]}`, c.cookie)
		require.Equal(t, http.StatusOK, status)
	}

	assert.Eventually(t, func() bool {
		return getSettings(t, srv.URL, cookieA).IgnoredTitleCounts[0] != nil &&
			getSettings(t, srv.URL, cookieB).IgnoredTitleCounts[0] != nil
	}, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, []*int{new(1)}, getSettings(t, srv.URL, cookieA).IgnoredTitleCounts)
	assert.Equal(t, []*int{new(3)}, getSettings(t, srv.URL, cookieB).IgnoredTitleCounts)
}

// A first refresh that fails leaves a snapshot with a stamp and nothing in it.
// That is not "no issues match": the answer is still unknown.
func TestSettingsGet_IgnoredTitleCounts_AreNullWhenTheOnlyForgeIsUnreachable(t *testing.T) {
	t.Parallel()
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != countsToken {
			return nil
		}

		return []dashboard.Source{&fakeConfiguredSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: false, Error: "down"}}}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)
	require.Eventually(t, func() bool {
		forges, _ := fetchDashboard(t, srv.URL, cookie)["forges"].([]any)

		return len(forges) == 1
	}, pollBudget, 10*time.Millisecond, "the first refresh has finished and failed")

	assert.Equal(t, []*int{nil}, getSettings(t, srv.URL, cookie).IgnoredTitleCounts)
}

func TestSettingsGet_IgnoredTitleCounts_AReachableForgeWithNoMatchesCountsZero(t *testing.T) {
	t.Parallel()
	srv := countsServer(t, map[string][]dashboard.Issue{countsToken: {countIssue(1, "a/x", "A real bug")}})
	cookie := signInWithBoard(t, srv, "ryan", countsToken, 1)
	status, _ := putSettings(t, srv.URL, `{"githubToken":"`+countsToken+`","ignoredTitles":["weekly"]}`, cookie)
	require.Equal(t, http.StatusOK, status)

	require.Eventually(t, func() bool { return getSettings(t, srv.URL, cookie).IgnoredTitleCounts[0] != nil }, 2*time.Second, 10*time.Millisecond)

	assert.Equal(t, []*int{new(0)}, getSettings(t, srv.URL, cookie).IgnoredTitleCounts)
}
