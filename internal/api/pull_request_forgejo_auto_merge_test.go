package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// armedNumber is the one pull request every test here puts on the board.
const armedNumber = 5

// forgejoAutoMergeBoard is a signed-in user with a Forgejo token and the given
// pull requests on the board. The source can't enable auto-merge on the forge
// at all, so a 204 shows the app kept the intent itself.
func forgejoAutoMergeBoard(t *testing.T, prs ...dashboard.PullRequest) (*httptest.Server, *http.Cookie) {
	t.Helper()

	src := &fakeConfiguredSource{}
	src.health = dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1}
	src.prs = prs
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.ForgejoToken == "" {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"forgejoUrl":"https://f.example","forgejoToken":"fj_secret"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		got, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(got) == len(prs)
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}

func forgejoPR(mutate func(*dashboard.PullRequest)) dashboard.PullRequest {
	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "alrayyes/a", Number: armedNumber,
		MergeStatus: dashboard.MergeMergeable, CI: dashboard.CIPending,
	}
	if mutate != nil {
		mutate(&pr)
	}

	return pr
}

func postForgejoAction(t *testing.T, srv *httptest.Server, cookie *http.Cookie, path, forge string) *http.Response {
	t.Helper()

	body := `{"forge":"` + forge + `","fullName":"alrayyes/a","number":` + strconv.Itoa(armedNumber) + `}`

	return doJSON(t, http.MethodPost, srv.URL+path, body, cookie)
}

// boardPR returns pull request number as the dashboard endpoint reports it.
func boardPR(t *testing.T, srv *httptest.Server, cookie *http.Cookie) map[string]any {
	t.Helper()

	prs, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)
	for _, p := range prs {
		if m, ok := p.(map[string]any); ok && int(m["number"].(float64)) == armedNumber {
			return m
		}
	}
	require.Failf(t, "pull request not on the board", "number %d", armedNumber)

	return nil
}

func allowedActionNames(t *testing.T, pr map[string]any) []string {
	t.Helper()

	var names []string
	actions, _ := pr["allowedActions"].([]any)
	for _, a := range actions {
		names = append(names, a.(map[string]any)["action"].(string))
	}

	return names
}

func TestForgejoAutoMerge_Arm_StoresTheIntentWithoutAskingTheForge(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestForgejoAutoMerge_Arm_BoardReportsItOn(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))
	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	pr := boardPR(t, srv, cookie)

	assert.Equal(t, true, pr["autoMergeEnabled"])
}

func TestForgejoAutoMerge_Arm_BoardOffersCancelInsteadOfEnable(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))
	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	pr := boardPR(t, srv, cookie)

	assert.Equal(t, []string{"merge", "close", "cancel_auto_merge"}, allowedActionNames(t, pr))
}

func TestForgejoAutoMerge_NotArmed_BoardOffersEnable(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	pr := boardPR(t, srv, cookie)

	assert.Contains(t, allowedActionNames(t, pr), "auto_merge")
}

func TestForgejoAutoMerge_Arm_Twice_IsA204Again(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))
	first := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = first.Body.Close()

	again := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = again.Body.Close()

	assert.Equal(t, http.StatusNoContent, again.StatusCode)
}

func TestForgejoAutoMerge_Arm_AlreadyCleanPullRequest_IsRefusedAndNotStored(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CISuccess }))

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	defer func() { _ = resp.Body.Close() }()
	var got map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	assert.Equal(t, "ready_to_merge", got["code"])
	assert.NotEqual(t, true, boardPR(t, srv, cookie)["autoMergeEnabled"])
}

func TestForgejoAutoMerge_Arm_WithConflicts_IsRefused(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(func(p *dashboard.PullRequest) { p.MergeStatus = dashboard.MergeConflicting }))

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
}

func TestForgejoAutoMerge_Cancel_RemovesTheIntent(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))
	armed := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = armed.Body.Close()

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.NotEqual(t, true, boardPR(t, srv, cookie)["autoMergeEnabled"])
}

func TestForgejoAutoMerge_Cancel_NothingArmed_IsA204(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestForgejoAutoMerge_Cancel_OnGitHub_Returns400(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge/cancel", "github")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestForgejoAutoMerge_Cancel_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()
	srv, _ := forgejoAutoMergeBoard(t, forgejoPR(nil))

	resp := postForgejoAction(t, srv, nil, "/api/pull-requests/auto-merge/cancel", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestForgejoAutoMerge_Arm_WithNoForgejoCredentials_Returns400(t *testing.T) {
	t.Parallel()
	srv := newTestServerWithSources(t, func([]byte, settingspkg.Credentials) []dashboard.Source { return nil })
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	saved := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"ghp_x"}`, cookie)
	_ = saved.Body.Close()

	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func autoMergeStatus(t *testing.T, pr map[string]any) map[string]any {
	t.Helper()

	status, _ := pr["autoMerge"].(map[string]any)

	return status
}

func TestForgejoAutoMerge_Armed_BoardSaysItIsWaitingForChecks(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))
	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	status := autoMergeStatus(t, boardPR(t, srv, cookie))

	assert.Equal(t, "waiting", status["state"])
	assert.Equal(t, "checks_pending", status["code"])
}

func TestForgejoAutoMerge_Armed_FailingChecksStopIt(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(func(p *dashboard.PullRequest) { p.CI = dashboard.CIFailure }))
	resp := postForgejoAction(t, srv, cookie, "/api/pull-requests/auto-merge", "forgejo")
	_ = resp.Body.Close()

	status := autoMergeStatus(t, boardPR(t, srv, cookie))

	assert.Equal(t, "stopped", status["state"])
}

func TestForgejoAutoMerge_NotArmed_HasNoStatus(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	assert.Nil(t, autoMergeStatus(t, boardPR(t, srv, cookie)))
}

func TestForgejoAutoMerge_Board_ListsNothingMergedAsAnEmptyArray(t *testing.T) {
	t.Parallel()
	srv, cookie := forgejoAutoMergeBoard(t, forgejoPR(nil))

	merged, ok := fetchDashboardWith(t, srv.URL, cookie, "")["autoMerged"].([]any)

	assert.True(t, ok)
	assert.Empty(t, merged)
}
