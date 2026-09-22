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

// fakeAutoMergerSource implements both dashboard.Source and
// dashboard.PullRequestAutoMerger directly — the shape github.Client has.
type fakeAutoMergerSource struct {
	forge        dashboard.Forge
	autoMergeErr error
	lastOwner    string
	lastName     string
	lastNumber   int
}

func (f *fakeAutoMergerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeAutoMergerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeAutoMergerSource) EnableAutoMerge(_ context.Context, owner, name string, number int) error {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.autoMergeErr
}

// postAutoMerge always targets GitHub — the only forge this action
// supports today (#526's own written decision to skip Forgejo for now).
func postAutoMerge(t *testing.T, srvURL string, sessionCookie *http.Cookie, fullName string, number int) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": fullName, "number": number})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/auto-merge", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestAutoMerge_EnablesAutoMergeOnTheNamedPullRequest(t *testing.T) {
	t.Parallel()

	source := &fakeAutoMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postAutoMerge(t, srvURL, sessionCookie, "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

func TestPullRequestAutoMerge_EnablingFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	source := &fakeAutoMergerSource{
		forge: dashboard.ForgeGitHub,
		autoMergeErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postAutoMerge(t, srvURL, sessionCookie, "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestPullRequestAutoMerge_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postAutoMerge(t, srvURL, sessionCookie, "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestAutoMerge_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeAutoMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postAutoMerge(t, srvURL, sessionCookie, "not-owner-slash-repo", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestAutoMerge_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeAutoMergerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/pull-requests/auto-merge", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
