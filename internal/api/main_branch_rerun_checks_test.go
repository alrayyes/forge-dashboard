package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBranchRerunSource implements dashboard.DefaultBranchRerunner and records
// each repository it was asked to rerun.
type fakeBranchRerunSource struct {
	fakeBranchCheckerSource
	err    error
	called []string
	// branches is the default branch each call was handed.
	branches []string
}

func (f *fakeBranchRerunSource) RerunFailedDefaultBranchChecks(_ context.Context, owner, name, defaultBranch string) error {
	f.called = append(f.called, owner+"/"+name)
	f.branches = append(f.branches, defaultBranch)

	return f.err
}

func postMainBranchRerun(t *testing.T, srvURL string, cookie *http.Cookie, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/v1/main-branches/rerun-checks", strings.NewReader(body))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	var got map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&got)

	return resp.StatusCode, got
}

func TestMainBranchRerunChecks_RerunsTheDefaultBranch_AndAnswers204(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub, tracked: []string{"alrayyes/tempus-fugit"}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"alrayyes/tempus-fugit"}`)

	assert.Equal(t, http.StatusNoContent, status)
	assert.Equal(t, []string{"alrayyes/tempus-fugit"}, source.called)
	assert.Equal(t, []string{"main"}, source.branches, "the row's branch is handed on")
}

func TestMainBranchRerunChecks_NothingFailed_Answers409WithTheForgeReason(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{
		forge: dashboard.ForgeGitHub, tracked: []string{"alrayyes/tempus-fugit"},
		err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: assert.AnError},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, body := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"alrayyes/tempus-fugit"}`)

	assert.Equal(t, http.StatusConflict, status)
	assert.NotEmpty(t, body["message"])
}

func TestMainBranchRerunChecks_ForgeWithNoSupport_Answers400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"forgejo","fullName":"alrayyes/tempus-fugit"}`)

	assert.Equal(t, http.StatusBadRequest, status)
}

func TestMainBranchRerunChecks_MalformedFullName_Answers400(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub, tracked: []string{"alrayyes/tempus-fugit"}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"nope"}`)

	assert.Equal(t, http.StatusBadRequest, status)
	assert.Empty(t, source.called)
}

func TestMainBranchRerunChecks_UnsafeFullName_Answers400AndNeverReachesTheForge(t *testing.T) {
	t.Parallel()

	for _, full := range []string{"alrayyes/..", "../tempus-fugit", "alrayyes/tempus?x=1", "alrayyes/tempus#frag", "alrayyes/tempus%2Ffugit", "alrayyes/tempus fugit"} {
		source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub, tracked: []string{full}}
		srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

		body, err := json.Marshal(map[string]string{"forge": "github", "fullName": full})
		require.NoError(t, err)
		status, _ := postMainBranchRerun(t, srvURL, cookie, string(body))

		assert.Equal(t, http.StatusBadRequest, status, full)
		assert.Empty(t, source.called, full)
	}
}

func TestMainBranchRerunChecks_UntrackedRepo_Answers404AndNeverReachesTheForge(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub, tracked: []string{"alrayyes/tempus-fugit"}}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"someone/else"}`)

	assert.Equal(t, http.StatusNotFound, status)
	assert.Empty(t, source.called)
}

func TestMainBranchRerunChecks_RefusalNamesTheBranchAction(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{
		forge: dashboard.ForgeGitHub, tracked: []string{"alrayyes/tempus-fugit"},
		err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: assert.AnError},
	}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, body := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"alrayyes/tempus-fugit"}`)

	assert.Equal(t, http.StatusConflict, status)
	assert.NotContains(t, body["code"], "pull_request")
}
