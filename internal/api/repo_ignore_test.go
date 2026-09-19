package api_test

import (
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

func postRepoAction(t *testing.T, srvURL string, sessionCookie *http.Cookie, path, fullName string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]string{"forge": "github", "fullName": fullName})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+path, strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

// newTestServerWithRepo saves GitHub credentials and returns a server
// whose one configured source reports one tracked repo carrying one open
// pull request and one open issue — the fixture #363's ignore/unignore
// tests filter against.
func newTestServerWithRepo(t *testing.T) (srvURL string, sessionCookie *http.Cookie) {
	t.Helper()

	const secretToken = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	repo := dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/forge-dashboard", URL: "https://github.com/alrayyes/forge-dashboard"}
	source := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: repo.FullName, Number: 1, Title: "A pull request", MergeStatus: dashboard.MergeUnknown},
		},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: repo.FullName, Number: 2, Title: "An issue"},
		},
		repos: []dashboard.Repo{repo},
	}

	buildSources := func(c settingspkg.Credentials) []dashboard.Source {
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
		snap := fetchDashboard(t, srv.URL, sessionCookie)

		return len(snap["pullRequests"].([]any)) == 1
	}, time.Second, 10*time.Millisecond, "the background refresh should have picked up the fixture PR")

	return srv.URL, sessionCookie
}

func fetchDashboard(t *testing.T, srvURL string, sessionCookie *http.Cookie) map[string]any {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/dashboard", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))

	return body
}

func TestRepoIgnore_RequiresASession(t *testing.T) {
	t.Parallel()

	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/api/repos/ignore", "application/json", strings.NewReader(`{"forge":"github","fullName":"alrayyes/forge-dashboard"}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestRepoIgnore_InvalidFullName_Returns400(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	resp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestRepoIgnore_ExcludesItsPullRequestsAndIssuesFromTheDashboard(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	ignoreResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "alrayyes/forge-dashboard")
	defer func() { _ = ignoreResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, ignoreResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	assert.Empty(t, snap["pullRequests"])
	assert.Empty(t, snap["issues"])
}

func TestRepoIgnore_RepoItselfStillListedWithAccurateWebhookStatus(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	ignoreResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "alrayyes/forge-dashboard")
	defer func() { _ = ignoreResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, ignoreResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, "alrayyes/forge-dashboard", repo["fullName"])
	assert.Equal(t, true, repo["ignored"])
}

func TestRepoIgnore_NotIgnored_ReportsIgnoredFalse(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	repos, ok := snap["repos"].([]any)
	require.True(t, ok)
	require.Len(t, repos, 1)
	repo := repos[0].(map[string]any)
	assert.Equal(t, false, repo["ignored"])
}

func TestRepoUnignore_BringsItsPullRequestsAndIssuesBack(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)
	ignoreResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "alrayyes/forge-dashboard")
	_ = ignoreResp.Body.Close()
	require.Equal(t, http.StatusNoContent, ignoreResp.StatusCode)

	unignoreResp := postRepoAction(t, srvURL, sessionCookie, "/api/repos/unignore", "alrayyes/forge-dashboard")
	defer func() { _ = unignoreResp.Body.Close() }()
	require.Equal(t, http.StatusNoContent, unignoreResp.StatusCode)

	snap := fetchDashboard(t, srvURL, sessionCookie)
	assert.Len(t, snap["pullRequests"], 1)
	assert.Len(t, snap["issues"], 1)
}

func TestRepoIgnore_Idempotent_IgnoringTwiceIsNotAnError(t *testing.T) {
	t.Parallel()

	srvURL, sessionCookie := newTestServerWithRepo(t)

	first := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "alrayyes/forge-dashboard")
	_ = first.Body.Close()
	require.Equal(t, http.StatusNoContent, first.StatusCode)

	second := postRepoAction(t, srvURL, sessionCookie, "/api/repos/ignore", "alrayyes/forge-dashboard")
	defer func() { _ = second.Body.Close() }()
	assert.Equal(t, http.StatusNoContent, second.StatusCode)
}
