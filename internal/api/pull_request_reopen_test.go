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

// fakePullRequestReopenerSource implements dashboard.Source,
// dashboard.PullRequestReopener and dashboard.PullRequestStateReader: the
// shape github.Client and forgejo.Client have.
type fakePullRequestReopenerSource struct {
	forge      dashboard.Forge
	reopenErr  error
	state      dashboard.PullRequestState
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakePullRequestReopenerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakePullRequestReopenerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakePullRequestReopenerSource) ReopenPullRequest(_ context.Context, owner, name string, number int) error {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.reopenErr
}

func (f *fakePullRequestReopenerSource) ReadPullRequestState(_ context.Context, _, _ string, _ int) (dashboard.PullRequestState, error) {
	return f.state, nil
}

func postReopenPullRequest(t *testing.T, srvURL string, sessionCookie *http.Cookie, number int) *http.Response {
	t.Helper()
	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/tempus-fugit", "number": number})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/reopen", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestReopen_CallsReopenPullRequestWithOwnerNameAndNumber(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestReopenerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postReopenPullRequest(t, srvURL, sessionCookie, 42)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNoContent, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
}

func TestPullRequestReopen_ForgeRefusesAClosedBranch_AnswersNotReopenable(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestReopenerSource{
		forge:     dashboard.ForgeGitHub,
		reopenErr: &dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: assert.AnError},
		state:     dashboard.PullRequestState{Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postReopenPullRequest(t, srvURL, sessionCookie, 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body map[string]any
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "not_reopenable", body["code"])
}

func TestPullRequestReopen_AlreadyMerged_AnswersConflict(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestReopenerSource{
		forge:     dashboard.ForgeGitHub,
		reopenErr: &dashboard.ClientError{Kind: dashboard.ForgeErrorUnknown, Err: assert.AnError},
		state:     dashboard.PullRequestState{Merged: true, Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postReopenPullRequest(t, srvURL, sessionCookie, 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body map[string]any
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "already_merged", body["code"])
}

func TestPullRequestReopen_ForgeWithNoReopenSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutCloseSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postReopenPullRequest(t, srvURL, sessionCookie, 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestReopen_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestReopenerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	body, err := json.Marshal(map[string]any{"forge": "github", "fullName": "alrayyes/a", "number": 1})
	require.NoError(t, err)
	resp, err := http.Post(srvURL+"/api/pull-requests/reopen", "application/json", strings.NewReader(string(body)))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}
