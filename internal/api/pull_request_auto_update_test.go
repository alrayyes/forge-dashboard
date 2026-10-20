package api_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// One pull request's own choice about automatic branch updates: what the
// dashboard says about it, and the endpoint that changes it.

const autoUpdatePath = "/api/pull-requests/auto-update"

// autoUpdateStates maps each pull request number to its `autoUpdate` object.
func autoUpdateStates(t *testing.T, srvURL string, cookie *http.Cookie) map[int]map[string]any {
	t.Helper()

	out := map[int]map[string]any{}
	prs, ok := fetchDashboardWith(t, srvURL, cookie, "")["pullRequests"].([]any)
	require.True(t, ok)
	for _, p := range prs {
		pr := p.(map[string]any)
		state, _ := pr["autoUpdate"].(map[string]any)
		out[int(pr["number"].(float64))] = state
	}

	return out
}

func setAutoUpdate(t *testing.T, srvURL string, cookie *http.Cookie, number int, enabled any) *http.Response {
	t.Helper()

	return postHide(t, srvURL, cookie, autoUpdatePath, map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": number, "enabled": enabled})
}

func TestDashboard_PullRequestCarriesItsAutoUpdateState_FromTheRepo(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)

	got := autoUpdateStates(t, srvURL, cookie)

	assert.Equal(t, true, got[1]["enabled"])
	assert.Equal(t, "repo", got[1]["source"])
	assert.Nil(t, got[1]["unavailable"])
}

func TestDashboard_PullRequestAutoUpdate_ReleasePleaseSaysWhyItIsUnavailable(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)

	got := autoUpdateStates(t, srvURL, cookie)

	assert.Equal(t, false, got[3]["enabled"])
	unavailable, ok := got[3]["unavailable"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "release_please", unavailable["code"])
	assert.NotEmpty(t, unavailable["reason"])
}

func TestPullRequestAutoUpdate_OptingOutOfAnEnabledRepo_ShowsItAndOffersUpdateBranchAgain(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)

	resp := setAutoUpdate(t, srvURL, cookie, 1, false)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	got := autoUpdateStates(t, srvURL, cookie)
	assert.Equal(t, false, got[1]["enabled"])
	assert.Equal(t, "pullRequest", got[1]["source"])
	assert.NotNil(t, updateBranchEntries(t, srvURL, cookie)[1], "the app no longer updates it, so the user can")
	assert.Equal(t, true, autoUpdateStates(t, srvURL, cookie)[2]["enabled"], "the other pull requests still follow the repo")
}

func TestPullRequestAutoUpdate_OptingInOnARepoThatIsOff_LeavesUpdateBranchOutForThatOne(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, false)

	resp := setAutoUpdate(t, srvURL, cookie, 1, true)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	got := autoUpdateStates(t, srvURL, cookie)
	assert.Equal(t, true, got[1]["enabled"])
	assert.Equal(t, "pullRequest", got[1]["source"])
	assert.Nil(t, updateBranchEntries(t, srvURL, cookie)[1], "the app is about to update it")
	assert.NotNil(t, updateBranchEntries(t, srvURL, cookie)[2], "the repo is still off for the others")
}

func TestPullRequestAutoUpdate_MatchingTheRepoAgain_DropsTheChoice(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)
	first := setAutoUpdate(t, srvURL, cookie, 1, false)
	_ = first.Body.Close()

	resp := setAutoUpdate(t, srvURL, cookie, 1, true)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	got := autoUpdateStates(t, srvURL, cookie)
	assert.Equal(t, true, got[1]["enabled"])
	assert.Equal(t, "repo", got[1]["source"], "a choice that equals the repo's setting is not kept")
}

func TestPullRequestAutoUpdate_NullEnabled_ReturnsItToTheRepoSetting(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)
	first := setAutoUpdate(t, srvURL, cookie, 1, false)
	_ = first.Body.Close()

	resp := setAutoUpdate(t, srvURL, cookie, 1, nil)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "repo", autoUpdateStates(t, srvURL, cookie)[1]["source"])
}

func TestPullRequestAutoUpdate_NotAPullRequestNumber_Is400(t *testing.T) {
	t.Parallel()
	srvURL, cookie := updateBranchServer(t, true)

	resp := setAutoUpdate(t, srvURL, cookie, 0, true)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestAutoUpdate_WithoutASession_Is401(t *testing.T) {
	t.Parallel()
	srvURL, _ := updateBranchServer(t, true)

	resp := setAutoUpdate(t, srvURL, nil, 1, true)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
