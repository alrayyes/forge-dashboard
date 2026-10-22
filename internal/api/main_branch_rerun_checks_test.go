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
}

func (f *fakeBranchRerunSource) RerunFailedDefaultBranchChecks(_ context.Context, owner, name string) error {
	f.called = append(f.called, owner+"/"+name)

	return f.err
}

func postMainBranchRerun(t *testing.T, srvURL string, cookie *http.Cookie, body string) (int, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/main-branches/rerun-checks", strings.NewReader(body))
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

	source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"alrayyes/tempus-fugit"}`)

	assert.Equal(t, http.StatusNoContent, status)
	assert.Equal(t, []string{"alrayyes/tempus-fugit"}, source.called)
}

func TestMainBranchRerunChecks_NothingFailed_Answers409WithTheForgeReason(t *testing.T) {
	t.Parallel()

	source := &fakeBranchRerunSource{
		forge: dashboard.ForgeGitHub,
		err:   &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: assert.AnError},
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

	source := &fakeBranchRerunSource{forge: dashboard.ForgeGitHub}
	srvURL, cookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postMainBranchRerun(t, srvURL, cookie, `{"forge":"github","fullName":"nope"}`)

	assert.Equal(t, http.StatusBadRequest, status)
	assert.Empty(t, source.called)
}
