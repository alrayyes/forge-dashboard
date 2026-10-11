package api_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// queueBoard is a signed-in user whose GitHub board holds four pull requests:
// #5 a plain behind one, #6 a behind Dependabot one, #7 a behind Renovate one
// and #8 one that is up to date. limited says whether GitHub's REST budget is
// spent until reset.
func queueBoard(t *testing.T, limited bool, reset time.Time) (*httptest.Server, *dashboard.Manager, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	health := dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}
	if limited {
		health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: 0, ResetsAt: reset}
	}
	now := time.Now().UTC()
	pr := func(number int, author string, behind bool) dashboard.PullRequest {
		return dashboard.PullRequest{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: number, Title: "A change", Author: author,
			URL: "https://github.com/alrayyes/a/pull/" + strconv.Itoa(number), Behind: behind,
			MergeStatus: dashboard.MergeMergeable, CI: dashboard.CISuccess,
			Labels: []dashboard.Label{}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
		}
	}
	src := &fakeConfiguredSource{
		health: health,
		prs: []dashboard.PullRequest{
			pr(5, "alice", true), pr(6, "dependabot[bot]", true), pr(7, "renovate[bot]", true), pr(8, "alice", false),
		},
	}
	srv, manager, _ := newTestServerWithSourcesAndManager(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srv.URL, cookie)["pullRequests"].([]any)

		return len(prs) == 4
	}, time.Second, 10*time.Millisecond)

	return srv, manager, cookie
}

func queueBody(action string, number int) string {
	return `{"action":"` + action + `","forge":"github","fullName":"alrayyes/a","number":` + strconv.Itoa(number) + `}`
}

// queueUpdate posts one Update branch queue request and returns the status and the decoded body.
func queueUpdate(t *testing.T, srv *httptest.Server, cookie *http.Cookie, number int) (int, map[string]any) {
	t.Helper()
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", number), cookie)
	defer func() { _ = resp.Body.Close() }()
	var out map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))

	return resp.StatusCode, out
}

func listQueued(t *testing.T, srv *httptest.Server, cookie *http.Cookie) []any {
	t.Helper()
	resp := doJSON(t, http.MethodGet, srv.URL+"/api/queued-actions", "", cookie)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var out []any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&out))

	return out
}

func TestQueuedActions_UpdateBranchOnALimitedForge_IsStoredUntilTheReset(t *testing.T) {
	t.Parallel()
	reset := time.Now().Add(30 * time.Minute).UTC().Truncate(time.Second)
	srv, _, cookie := queueBoard(t, true, reset)

	status, got := queueUpdate(t, srv, cookie, 5)

	require.Equal(t, http.StatusCreated, status)
	assert.Equal(t, "queued", got["status"])
	assert.Equal(t, "update_branch", got["action"])
	assert.NotEmpty(t, got["id"])
	runAt, err := time.Parse(time.RFC3339, got["runAt"].(string))
	require.NoError(t, err)
	assert.True(t, reset.Equal(runAt), "runAt %s should be the forge's reset %s", runAt, reset)
}

func TestQueuedActions_ThenList_ReturnsIt(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), cookie)
	_ = resp.Body.Close()

	assert.Len(t, listQueued(t, srv, cookie), 1)
}

func TestQueuedActions_ShowOnThePullRequestAndInTheDashboard(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), cookie)
	_ = resp.Body.Close()

	board := fetchDashboard(t, srv.URL, cookie)

	assert.Len(t, board["queuedActions"], 1)
	for _, p := range board["pullRequests"].([]any) {
		pr := p.(map[string]any)
		if pr["number"].(float64) == 5 {
			queued, ok := pr["queued"].(map[string]any)
			require.True(t, ok, "#5 should carry queued")
			assert.Equal(t, "update_branch", queued["action"])
		} else {
			assert.Nil(t, pr["queued"], "#%v has nothing queued", pr["number"])
		}
	}
}

func TestQueuedActions_BotRebases_AreQueueable(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	for action, number := range map[string]int{"dependabot_rebase": 6, "renovate_rebase": 7} {
		resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody(action, number), cookie)
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusCreated, resp.StatusCode, action)
	}
}

func TestQueuedActions_MergeAndCloseAndTheRest_AreRefusedWith400(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	for _, action := range []string{"merge", "close", "auto_merge", "cancel_auto_merge", "dependabot_recreate", "rerun_checks", "nonsense", ""} {
		t.Run("action "+action, func(t *testing.T) {
			t.Parallel()
			resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody(action, 5), cookie)
			_ = resp.Body.Close()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
	assert.Empty(t, listQueued(t, srv, cookie), "nothing was stored")
}

func TestQueuedActions_ForgeNotLimited_Answers409NotRateLimited(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, false, time.Time{})

	status, got := queueUpdate(t, srv, cookie, 5)

	require.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "not_rate_limited", got["code"])
	assert.Empty(t, listQueued(t, srv, cookie))
}

func TestQueuedActions_ResetAlreadyPassed_Answers409NotRateLimited(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(-time.Minute))

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), cookie)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
}

func TestQueuedActions_PullRequestNotBehind_Answers409AlreadyUpToDate(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	status, got := queueUpdate(t, srv, cookie, 8)

	require.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "already_up_to_date", got["code"])
}

func TestQueuedActions_UpdateBranchOnABotPullRequest_IsRefused(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 6), cookie)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusConflict, resp.StatusCode, "a Dependabot pull request updates through its own rebase")
}

func TestQueuedActions_BotRebaseOnTheWrongAuthor_IsRefused(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("dependabot_rebase", 5), cookie)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
}

func TestQueuedActions_PullRequestNotOnTheBoard_Answers404(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 9), cookie)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestQueuedActions_BadBody_Answers400(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	for name, body := range map[string]string{
		"not json":       `nope`,
		"no slash":       `{"action":"update_branch","forge":"github","fullName":"alrayyes","number":5}`,
		"number too big": `{"action":"update_branch","forge":"github","fullName":"alrayyes/a","number":99999999999}`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", body, cookie)
			_ = resp.Body.Close()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
}

func TestQueuedActions_SameActionTwice_ReturnsTheFirstWith200(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	_, first := queueUpdate(t, srv, cookie, 5)

	status, second := queueUpdate(t, srv, cookie, 5)

	require.Equal(t, http.StatusOK, status)
	assert.Equal(t, first["id"], second["id"])
	assert.Len(t, listQueued(t, srv, cookie), 1)
}

func TestQueuedActions_Cancel_RemovesItAndClearsThePullRequest(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	_, created := queueUpdate(t, srv, cookie, 5)

	resp := doJSON(t, http.MethodDelete, srv.URL+"/api/queued-actions/"+created["id"].(string), "", cookie)
	_ = resp.Body.Close()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Empty(t, listQueued(t, srv, cookie))
	assert.Empty(t, fetchDashboard(t, srv.URL, cookie)["queuedActions"])
}

func TestQueuedActions_CancelUnknownID_Answers404(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	resp := doJSON(t, http.MethodDelete, srv.URL+"/api/queued-actions/nope", "", cookie)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestQueuedActions_RequireASession(t *testing.T) {
	t.Parallel()
	srv := newTestServer(t)

	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/queued-actions", ""},
		{http.MethodPost, "/api/queued-actions", queueBody("update_branch", 5)},
		{http.MethodDelete, "/api/queued-actions/abc", ""},
	} {
		resp := doJSON(t, c.method, srv.URL+c.path, c.body, nil)
		_ = resp.Body.Close()

		assert.Equal(t, http.StatusUnauthorized, resp.StatusCode, c.method+" "+c.path)
	}
}

func TestQueuedActions_AnotherUser_NeitherSeesNorCancelsThem(t *testing.T) {
	t.Parallel()
	srv, _, owner := queueBoard(t, true, time.Now().Add(time.Hour))
	_, created := queueUpdate(t, srv, owner, 5)
	token := createInviteViaAdmin(t, srv, owner, testOtherUser, "Alex")
	other, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)

	assert.Empty(t, listQueued(t, srv, other), "the other user's list")
	assert.Empty(t, fetchDashboard(t, srv.URL, other)["queuedActions"], "the other user's dashboard")
	resp := doJSON(t, http.MethodDelete, srv.URL+"/api/queued-actions/"+created["id"].(string), "", other)
	_ = resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode, "cancelling someone else's")
	assert.Len(t, listQueued(t, srv, owner), 1, "the owner's item is untouched")
}

func TestQueuedActions_AnotherUser_CannotQueueOnTheOwnersBoard(t *testing.T) {
	t.Parallel()
	srv, _, owner := queueBoard(t, true, time.Now().Add(time.Hour))
	token := createInviteViaAdmin(t, srv, owner, testOtherUser, "Alex")
	other, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)

	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), other)
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode, "that user has no such pull request on their board")
}

func TestQueuedActions_SharedDashboard_DoesNotRevealTheOwnersQueue(t *testing.T) {
	t.Parallel()
	srv, _, owner := queueBoard(t, true, time.Now().Add(time.Hour))
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), owner)
	_ = resp.Body.Close()
	token := createInviteViaAdmin(t, srv, owner, testOtherUser, "Alex")
	viewer, _, _ := registerViaRealCeremony(t, srv, testOtherUser, "Alex", token)
	share := doJSON(t, http.MethodPut, srv.URL+"/api/sharing/"+testOtherUser, "", owner)
	_ = share.Body.Close()
	require.Equal(t, http.StatusNoContent, share.StatusCode)

	board := fetchDashboardWith(t, srv.URL, viewer, "?owner="+testUser)

	require.NotEmpty(t, board["pullRequests"], "the shared board is visible")
	assert.Empty(t, board["queuedActions"])
	for _, p := range board["pullRequests"].([]any) {
		assert.Nil(t, p.(map[string]any)["queued"])
	}
}

func TestQueuedActions_SurviveARestart(t *testing.T) {
	t.Parallel()
	srv, manager, cookie := queueBoard(t, true, time.Now().Add(time.Hour))
	resp := doJSON(t, http.MethodPost, srv.URL+"/api/queued-actions", queueBody("update_branch", 5), cookie)
	_ = resp.Body.Close()

	manager.Stop() // what a restart does to every aggregator

	assert.Len(t, listQueued(t, srv, cookie), 1)
}

func TestContract_QueuedActions(t *testing.T) {
	t.Parallel()
	srv, _, cookie := queueBoard(t, true, time.Now().Add(time.Hour))

	call := func(method, path, body string) (*http.Request, recorded) {
		req, err := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.AddCookie(cookie)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		defer func() { _ = resp.Body.Close() }()
		respBody, err := io.ReadAll(resp.Body)
		require.NoError(t, err)

		return req, recorded{status: resp.StatusCode, header: resp.Header, body: respBody}
	}
	check := func(want int, method, path, body string) recorded {
		t.Helper()
		req, got := call(method, path, body)
		require.Equal(t, want, got.status, string(got.body))
		// kin-openapi reads the request body to validate it; give it its own copy.
		req.Body = nil
		validateAgainstSpec(t, req, got)

		return got
	}

	created := check(http.StatusCreated, http.MethodPost, "/api/queued-actions", queueBody("update_branch", 5))
	check(http.StatusOK, http.MethodPost, "/api/queued-actions", queueBody("update_branch", 5))
	check(http.StatusBadRequest, http.MethodPost, "/api/queued-actions", queueBody("merge", 5))
	check(http.StatusConflict, http.MethodPost, "/api/queued-actions", queueBody("update_branch", 8))
	check(http.StatusNotFound, http.MethodPost, "/api/queued-actions", queueBody("update_branch", 9))
	check(http.StatusOK, http.MethodGet, "/api/queued-actions", "")
	check(http.StatusOK, http.MethodGet, "/api/dashboard", "")
	var item map[string]any
	require.NoError(t, json.Unmarshal(created.body, &item))
	check(http.StatusNoContent, http.MethodDelete, "/api/queued-actions/"+item["id"].(string), "")
	check(http.StatusNotFound, http.MethodDelete, "/api/queued-actions/"+item["id"].(string), "")
}
