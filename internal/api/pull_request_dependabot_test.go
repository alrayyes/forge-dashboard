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

// fakeCommenterSource implements both dashboard.Source and
// dashboard.PullRequestCommenter directly — the shape github.Client has.
type fakeCommenterSource struct {
	forge      dashboard.Forge
	commentErr error
	lastOwner  string
	lastName   string
	lastNumber int
	lastBody   string
}

func (f *fakeCommenterSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeCommenterSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeCommenterSource) CommentPullRequest(_ context.Context, owner, name string, number int, body string) error {
	f.lastOwner, f.lastName, f.lastNumber, f.lastBody = owner, name, number, body
	return f.commentErr
}

func postDependabotAction(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int, action string) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": forge, "fullName": fullName, "number": number, "action": action})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/dependabot-action", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	return resp
}

func TestPullRequestDependabotAction_Rebase_PostsExactCommentText(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42, "rebase")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
	assert.Equal(t, "@dependabot rebase", source.lastBody)
}

func TestPullRequestDependabotAction_Recreate_PostsExactCommentText(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1, "recreate")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "@dependabot recreate", source.lastBody)
}

func TestPullRequestDependabotAction_UnknownAction_Returns400AndPostsNothing(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1, "close")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
	assert.Empty(t, source.lastBody)
}

func TestPullRequestDependabotAction_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1, "rebase")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestDependabotAction_CommentFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{
		forge: dashboard.ForgeGitHub,
		commentErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1, "rebase")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestPullRequestDependabotAction_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postDependabotAction(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1, "rebase")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestDependabotAction_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeCommenterSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1, "action": "rebase"})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/pull-requests/dependabot-action", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
