package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

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
	state      dashboard.PullRequestState
	stateErr   error
	stateReads int
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

func (f *fakePullRequestMergerSource) ReadPullRequestState(_ context.Context, _, _ string, _ int) (dashboard.PullRequestState, error) {
	f.stateReads++

	return f.state, f.stateErr
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

type actionErrorBody struct {
	Error    string     `json:"error"`
	Code     string     `json:"code"`
	Message  string     `json:"message"`
	ResetsAt *time.Time `json:"resetsAt"`
}

func mergeRefusal(kind dashboard.ForgeErrorKind, text string) error {
	return &dashboard.ClientError{Kind: kind, Err: errors.New(text)}
}

func TestPullRequestMerge_RefusedOnAnAlreadyMergedPR_AnswersAlreadyMerged(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeGitHub,
		mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT /repos/alrayyes/a/pulls/1/merge: Pull Request is not mergeable"),
		state:    dashboard.PullRequestState{Merged: true, Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "already_merged", body.Code)
	assert.NotEmpty(t, body.Message)
	assert.Contains(t, body.Error, "Pull Request is not mergeable")
}

func TestPullRequestMerge_RefusedOnAClosedPR_AnswersAlreadyClosed(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeForgejo,
		mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "forgejo: POST x: not mergeable"),
		state:    dashboard.PullRequestState{Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "already_closed", body.Code)
}

func TestPullRequestMerge_RefusedWithAConflict_AnswersConflictFromTheReRead(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeGitHub,
		mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT x: Pull Request is not mergeable"),
		state:    dashboard.PullRequestState{Conflicting: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "conflict", body.Code)
	assert.Equal(t, 1, source.stateReads)
}

func TestPullRequestMerge_ReReadFails_ReturnsTheOriginalErrorWithCodeUnknown(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeGitHub,
		mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT x: Head branch was modified. Review and try the merge again."),
		stateErr: mergeRefusal(dashboard.ForgeErrorUnreachable, "github: GET x: timeout"),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "unknown", body.Code)
	assert.Contains(t, body.Error, "Head branch was modified")
	assert.Equal(t, "Head branch was modified. Review and try the merge again.", body.Message)
}

func TestPullRequestMerge_UncodedFailure_KeepsTheRawTextOutOfTheResponse(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeGitHub,
		mergeErr: mergeRefusal(dashboard.ForgeErrorUnknown, "dashboard: merge pull request: forgejo: PUT /repos/alrayyes/a/pulls/1/merge: 422 see https://git.example/api/swagger"),
		stateErr: mergeRefusal(dashboard.ForgeErrorUnreachable, "github: GET x: timeout"),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "unknown", body.Code)
	assert.Equal(t, "The forge refused this action and gave no reason.", body.Message)
	assert.Equal(t, body.Message, body.Error, "the raw text belongs in the server log, not the response")
}

func TestPullRequestMerge_SourceWithoutStateReader_AnswersUnknownWithTheOriginalStatus(t *testing.T) {
	t.Parallel()

	source := &mergeOnlySource{forge: dashboard.ForgeGitHub, err: mergeRefusal(dashboard.ForgeErrorConflict, "github: PUT x: Pull Request is not mergeable")}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "unknown", body.Code)
}

func TestPullRequestMerge_PermissionAndRateLimit_KeepTheirStatus(t *testing.T) {
	t.Parallel()

	reset := time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)
	// A 403 re-reads the pull request, in case it was merged or closed (#904);
	// a rate limit can't, since the re-read would be limited too.
	cases := []struct {
		name      string
		err       error
		status    int
		code      string
		stateRead int
	}{
		{"403", mergeRefusal(dashboard.ForgeErrorUnauthorized, "github: PUT x: Resource not accessible"), http.StatusForbidden, "permission", 1},
		{"429", &dashboard.ClientError{Kind: dashboard.ForgeErrorRateLimited, Err: errors.New("github: PUT x: rate limit exceeded"), RateLimit: &dashboard.RateLimit{ResetsAt: reset}}, http.StatusTooManyRequests, "rate_limited", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			source := &fakePullRequestMergerSource{forge: dashboard.ForgeGitHub, mergeErr: tc.err}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.status, resp.StatusCode)
			var body actionErrorBody
			require.NoError(t, readJSON(resp, &body))
			assert.Equal(t, tc.code, body.Code)
			assert.Equal(t, tc.stateRead, source.stateReads)
			if tc.code == "rate_limited" {
				require.NotNil(t, body.ResetsAt)
				assert.True(t, reset.Equal(*body.ResetsAt))
			}
		})
	}
}

// mergeOnlySource merges but cannot re-read a PR's state.
type mergeOnlySource struct {
	forge dashboard.Forge
	err   error
}

func (f *mergeOnlySource) Forge() dashboard.Forge { return f.forge }

func (f *mergeOnlySource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *mergeOnlySource) MergePullRequest(_ context.Context, _, _ string, _ int) error {
	return f.err
}

// The Forgejo case reported live: Merge on an already-merged PR is refused
// with an empty message, so only the re-read (merged=true) can say why.
func TestPullRequestMerge_ForgejoEmptyRefusalOnMergedPR_AnswersAlreadyMergedFromTheReRead(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeForgejo,
		mergeErr: mergeRefusal(dashboard.ForgeErrorConflict, "forgejo: POST /repos/alrayyes/a/pulls/1/merge: 405 Method Not Allowed"),
		state:    dashboard.PullRequestState{Merged: true, Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "forgejo", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "already_merged", body.Code)
	assert.NotContains(t, body.Message, "{")
}

// The same, through the endpoint (#904): a 403 on a pull request that turns out
// to be merged answers 409 already_merged, and the permission answer stays for
// a pull request that is still open.
func TestPullRequestMerge_PermissionRefusalOnAMergedPullRequest_AnswersAlreadyMerged(t *testing.T) {
	t.Parallel()

	source := &fakePullRequestMergerSource{
		forge:    dashboard.ForgeGitHub,
		mergeErr: mergeRefusal(dashboard.ForgeErrorUnauthorized, "github: PUT x: Resource not accessible by integration"),
		state:    dashboard.PullRequestState{Merged: true, Closed: true},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := postMergePullRequest(t, srvURL, sessionCookie, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusConflict, resp.StatusCode)
	var body actionErrorBody
	require.NoError(t, readJSON(resp, &body))
	assert.Equal(t, "already_merged", body.Code)
	assert.Equal(t, 1, source.stateReads, "the pull request was re-read")
}
