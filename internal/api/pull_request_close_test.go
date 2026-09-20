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

// fakePullRequestCloserSource implements both dashboard.Source and
// dashboard.PullRequestCloser directly — the shape github.Client and
// forgejo.Client have. Mirrors fakePullRequestMergerSource.
type fakePullRequestCloserSource struct {
	forge      dashboard.Forge
	closeErr   error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakePullRequestCloserSource) Forge() dashboard.Forge { return f.forge }

func (f *fakePullRequestCloserSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakePullRequestCloserSource) ClosePullRequest(_ context.Context, owner, name string, number int) error {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.closeErr
}

// fakeSourceWithoutCloseSupport implements dashboard.Source only — the
// shape a forge with no close support at all would have.
type fakeSourceWithoutCloseSupport struct{ forge dashboard.Forge }

func (f *fakeSourceWithoutCloseSupport) Forge() dashboard.Forge { return f.forge }

func (f *fakeSourceWithoutCloseSupport) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func postClosePullRequest(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": forge, "fullName": fullName, "number": number})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/close", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestClose_CallsClosePullRequestWithOwnerNameAndNumber(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

func TestPullRequestClose_ForgejoDispatchesToTheForgejoSource(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 7)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 7, source.lastNumber)
}

func TestPullRequestClose_ForgeRejects_ClassifiesAsItsOwnStatus(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{
		forge: dashboard.ForgeGitHub,
		closeErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorNotFound,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	var body map[string]string
	require.NoError(t, readJSON(resp, &body))
	assert.Contains(t, body["error"], assert.AnError.Error())
}

func TestPullRequestClose_ForgeWithNoCloseSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutCloseSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestClose_NoCredentialsSavedForThatForge_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestClose_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postClosePullRequest(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestClose_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestCloserSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/pull-requests/close", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
