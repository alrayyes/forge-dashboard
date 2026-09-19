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

// fakePullRequestMergerSource implements both dashboard.Source and
// dashboard.PullRequestMerger directly — the shape github.Client has;
// GenericSource's own delegation to a ForgeClient is covered by
// internal/dashboard's own tests, so this is enough to exercise the
// handler without a second copy of that coverage.
type fakePullRequestMergerSource struct {
	forge      dashboard.Forge
	mergeErr   error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakePullRequestMergerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakePullRequestMergerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakePullRequestMergerSource) MergePullRequest(_ context.Context, owner, name string, number int) error {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.mergeErr
}

// fakeSourceWithoutMergeSupport implements dashboard.Source only — the
// shape a forge with no merge support at all would have.
type fakeSourceWithoutMergeSupport struct{ forge dashboard.Forge }

func (f *fakeSourceWithoutMergeSupport) Forge() dashboard.Forge { return f.forge }

func (f *fakeSourceWithoutMergeSupport) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func postMergePullRequest(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": forge, "fullName": fullName, "number": number})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/merge", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestMerge_CallsMergePullRequestWithOwnerNameAndNumber(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

func TestPullRequestMerge_ForgejoDispatchesToTheForgejoSource(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 7)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, 7, source.lastNumber)
}

func TestPullRequestMerge_NotMergeable_ClassifiesAs409(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge: dashboard.ForgeGitHub,
		mergeErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorConflict,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body map[string]string
	require.NoError(t, readJSON(resp, &body))
	assert.Contains(t, body["error"], assert.AnError.Error())
}

func TestPullRequestMerge_RateLimited_ClassifiesAs429(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge: dashboard.ForgeGitHub,
		mergeErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorRateLimited,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusTooManyRequests, resp.StatusCode)
}

func TestPullRequestMerge_ForgeWithNoMergeSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutMergeSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestMerge_NoCredentialsSavedForThatForge_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestMerge_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestMerge_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/pull-requests/merge", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
