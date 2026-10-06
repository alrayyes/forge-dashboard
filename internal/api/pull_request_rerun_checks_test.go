package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// rerunSource lists the pull requests it was given and records each rerun, so
// a test can tell a refusal made by the server from one made by the forge.
type rerunSource struct {
	fakeConfiguredSource
	err    error
	mu     sync.Mutex
	called []string
}

func (s *rerunSource) RerunFailedChecks(_ context.Context, owner, name string, number int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.called = append(s.called, owner+"/"+name+"#"+strconv.Itoa(number))

	return s.err
}

func (s *rerunSource) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.called...)
}

func rerunBoard(t *testing.T, rerunErr error, prs ...dashboard.PullRequest) (*httptest.Server, *http.Cookie, *rerunSource) {
	t.Helper()

	return rerunBoardFor(t, dashboard.ForgeGitHub, rerunErr, prs...)
}

// rerunBoardFor is rerunBoard for either forge: the source answers for forge,
// and only that forge's token builds it.
func rerunBoardFor(t *testing.T, forge dashboard.Forge, rerunErr error, prs ...dashboard.PullRequest) (*httptest.Server, *http.Cookie, *rerunSource) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	src := &rerunSource{err: rerunErr}
	src.health = dashboard.ForgeHealth{Forge: forge, Reachable: true, RepoCount: 1}
	src.prs = prs
	settingsBody := `{"githubToken":"` + token + `"}`
	if forge == dashboard.ForgeForgejo {
		settingsBody = `{"forgejoUrl":"https://git.example","forgejoToken":"` + token + `"}`
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token && c.ForgejoToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", settingsBody, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		got, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(got) == len(prs)
	}, time.Second, 10*time.Millisecond)

	return srv, cookie, src
}

func postRerunChecks(t *testing.T, srvURL string, cookie *http.Cookie) (int, map[string]any) {
	t.Helper()

	return postRerunChecksFor(t, "github", srvURL, cookie)
}

func postRerunChecksFor(t *testing.T, forge, srvURL string, cookie *http.Cookie) (int, map[string]any) {
	t.Helper()

	body, err := json.Marshal(map[string]any{"forge": forge, "fullName": "alrayyes/a", "number": 5})
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, srvURL+"/api/pull-requests/rerun-checks", strings.NewReader(string(body)))
	require.NoError(t, err)
	req.AddCookie(cookie)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)

	var got map[string]any
	if len(raw) > 0 {
		require.NoError(t, json.Unmarshal(raw, &got), string(raw))
	}

	return resp.StatusCode, got
}

func failingPR() dashboard.PullRequest {
	return dashboard.PullRequest{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, MergeStatus: dashboard.MergeBlocked, CI: dashboard.CIFailure}
}

func TestPullRequestRerunChecks_Reruns_AndAnswers204(t *testing.T) {
	t.Parallel()

	srv, cookie, src := rerunBoard(t, nil, failingPR())

	status, _ := postRerunChecks(t, srv.URL, cookie)

	assert.Equal(t, http.StatusNoContent, status)
	assert.Equal(t, []string{"alrayyes/a#5"}, src.calls())
}

func TestPullRequestRerunChecks_RefusesWhatAllowedActionsDoesNotOffer_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	passing := failingPR()
	passing.CI = dashboard.CISuccess
	srv, cookie, src := rerunBoard(t, nil, passing)

	status, body := postRerunChecks(t, srv.URL, cookie)

	assert.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "not_mergeable", body["code"])
	assert.Contains(t, body["message"], "no failed checks")
	assert.Empty(t, src.calls(), "the forge must not be asked")
}

func TestPullRequestRerunChecks_ForgeRefusals_AreShownInTheirOwnWords(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		err        error
		wantStatus int
		wantCode   string
		wantText   string
	}{
		"no failed Actions job": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("no failed GitHub Actions job to rerun on this pull request")},
			http.StatusConflict, "unknown", "no failed GitHub Actions job",
		},
		"the token may not rerun": {
			&dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("Resource not accessible by integration")},
			http.StatusForbidden, "permission", "",
		},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			srv, cookie, _ := rerunBoard(t, tc.err, failingPR())

			status, body := postRerunChecks(t, srv.URL, cookie)

			assert.Equal(t, tc.wantStatus, status)
			assert.Equal(t, tc.wantCode, body["code"])
			assert.Contains(t, body["message"], tc.wantText)
			assert.NotEmpty(t, body["message"])
		})
	}
}

func TestPullRequestRerunChecks_ForgeWithNoRerunSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutCloseSupport{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	status, _ := postRerunChecks(t, srvURL, sessionCookie)

	assert.Equal(t, http.StatusBadRequest, status)
}

func TestPullRequestRerunChecks_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutCloseSupport{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp, err := http.Post(srvURL+"/api/pull-requests/rerun-checks", "application/json", strings.NewReader(`{}`))
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func failingForgejoPR() dashboard.PullRequest {
	pr := failingPR()
	pr.Forge = dashboard.ForgeForgejo

	return pr
}

func TestPullRequestRerunChecks_OnForgejo_Reruns_AndAnswers204(t *testing.T) {
	t.Parallel()

	srv, cookie, src := rerunBoardFor(t, dashboard.ForgeForgejo, nil, failingForgejoPR())

	status, _ := postRerunChecksFor(t, "forgejo", srv.URL, cookie)

	assert.Equal(t, http.StatusNoContent, status)
	assert.Equal(t, []string{"alrayyes/a#5"}, src.calls())
}

func TestPullRequestRerunChecks_OnForgejo_RefusesAPassingPullRequest_WithoutAskingTheForge(t *testing.T) {
	t.Parallel()

	passing := failingForgejoPR()
	passing.CI = dashboard.CISuccess
	srv, cookie, src := rerunBoardFor(t, dashboard.ForgeForgejo, nil, passing)

	status, _ := postRerunChecksFor(t, "forgejo", srv.URL, cookie)

	assert.Equal(t, http.StatusConflict, status)
	assert.Empty(t, src.calls(), "the forge must not be asked")
}

func TestPullRequestRerunChecks_OnForgejo_NoFailedJob_Is409InThePlainSentence(t *testing.T) {
	t.Parallel()

	noRun := &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: errors.New("no failed job to rerun on this pull request")}
	srv, cookie, _ := rerunBoardFor(t, dashboard.ForgeForgejo, noRun, failingForgejoPR())

	status, body := postRerunChecksFor(t, "forgejo", srv.URL, cookie)

	assert.Equal(t, http.StatusConflict, status)
	assert.Equal(t, "no failed job to rerun on this pull request", body["message"])
}

func TestPullRequestRerunChecks_OnForgejo_TheTokenMayNotRerun_Is403(t *testing.T) {
	t.Parallel()

	denied := &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: errors.New("forgejo: POST /x: refused: token does not have the scope")}
	srv, cookie, _ := rerunBoardFor(t, dashboard.ForgeForgejo, denied, failingForgejoPR())

	status, _ := postRerunChecksFor(t, "forgejo", srv.URL, cookie)

	assert.Equal(t, http.StatusForbidden, status)
}
