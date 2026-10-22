package api_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeJobLogSource implements dashboard.Source and dashboard.JobLogReader, the
// shape github.Client has.
type fakeJobLogSource struct {
	forge     dashboard.Forge
	repos     []string // full names the source reports as tracked
	log       dashboard.JobLog
	err       error
	lastOwner string
	lastName  string
	lastJob   int64
}

func (f *fakeJobLogSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeJobLogSource) Fetch(_ context.Context) dashboard.Result {
	repos := make([]dashboard.Repo, 0, len(f.repos))
	for _, name := range f.repos {
		repos = append(repos, dashboard.Repo{Forge: f.forge, FullName: name})
	}

	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}, Repos: repos}
}

func (f *fakeJobLogSource) JobLog(_ context.Context, owner, name string, jobID int64) (dashboard.JobLog, error) {
	f.lastOwner, f.lastName, f.lastJob = owner, name, jobID

	return f.log, f.err
}

func getJobLog(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName, jobID string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {forge}, "fullName": {fullName}, "jobId": {jobID}}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/checks/log?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestJobLog_ReturnsTheText(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"alrayyes/tempus-fugit"}, log: dashboard.JobLog{Text: "step 1\nstep 2\n", Truncated: true}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", "4242")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.EqualValues(t, 4242, source.lastJob)
	var body dashboard.JobLog
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "step 1\nstep 2\n", body.Text)
	assert.True(t, body.Truncated)
}

func TestJobLog_BadInput_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	for name, args := range map[string][3]string{
		"malformed full name": {"github", "no-slash", "1"},
		"job id not a number": {"github", "a/b", "x"},
		"job id missing":      {"github", "a/b", ""},
		"job id not positive": {"github", "a/b", "0"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := getJobLog(t, srvURL, sessionCookie, args[0], args[1], args[2])
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
}

func TestJobLog_BadJobID_SaysWhichRuleItBroke(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	for name, tc := range map[string]struct{ id, want string }{
		"empty":     {"", "jobId is required"},
		"letters":   {"x", "jobId must be digits only"},
		"signed":    {"-5", "jobId must be digits only"},
		"too large": {"99999999999999999999", "jobId is too large"},
		"zero":      {"0", "jobId must be a positive integer"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", tc.id)
			defer func() { _ = resp.Body.Close() }()

			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			var body struct {
				Error string `json:"error"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
			assert.Equal(t, tc.want, body.Error)
		})
	}
}

func TestJobLog_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getJobLog(t, srvURL, sessionCookie, "forgejo", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestJobLog_ForgeRefuses_MapsTheStatusAndKeepsAPlainMessage(t *testing.T) {
	t.Parallel()

	for kind, want := range map[dashboard.ForgeErrorKind]int{
		dashboard.ForgeErrorUnauthorized: http.StatusForbidden,
		dashboard.ForgeErrorNotFound:     http.StatusNotFound,
		dashboard.ForgeErrorRateLimited:  http.StatusTooManyRequests,
	} {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()

			source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"a/b"}, err: &dashboard.ClientError{Kind: kind, Err: assert.AnError}}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", "1")
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, want, resp.StatusCode)
			var body struct {
				Error string `json:"error"`
			}
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
			assert.NotEmpty(t, body.Error)
		})
	}
}

func TestJobLog_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, nil, "github", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// fakeForgeClientWithJobLog is the shape internal/forgejo.Client has, driven
// through dashboard.GenericSource so the Source's forwarding is exercised too.
type fakeForgeClientWithJobLog struct {
	fakeForgeClientWithChecker
	lastJob int64
}

func (f *fakeForgeClientWithJobLog) ListRepos(_ context.Context) ([]dashboard.RepoRef, error) {
	return []dashboard.RepoRef{{FullName: "a/b", Owner: "a", Name: "b"}}, nil
}

func (f *fakeForgeClientWithJobLog) JobLog(_ context.Context, owner, name string, jobID int64) (dashboard.JobLog, error) {
	f.lastOwner, f.lastName, f.lastJob = owner, name, jobID

	return dashboard.JobLog{Text: "hello\n"}, nil
}

func TestJobLog_ForgejoViaGenericSource_ReturnsTheText(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClientWithJobLog{}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getJobLog(t, srvURL, sessionCookie, "forgejo", "a/b", "7")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.EqualValues(t, 7, client.lastJob)
}

func TestJobLog_HostileInput_Returns400AndNeverReachesTheForge(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	for name, args := range map[string][2]string{
		"dot-dot owner":          {"../b", "1"},
		"dot-dot repo":           {"a/..", "1"},
		"single dot repo":        {"a/.", "1"},
		"query in the repo":      {"a/b?x=1", "1"},
		"fragment in the repo":   {"a/b#x", "1"},
		"percent in the repo":    {"a/b%2e%2e", "1"},
		"extra segment":          {"a/b/c", "1"},
		"space in the owner":     {"a b/c", "1"},
		"backslash":              {`a\b/c`, "1"},
		"job id overflows int64": {"a/b", "99999999999999999999"},
		"job id with a sign":     {"a/b", "+5"},
		"job id with a space":    {"a/b", "5 "},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			resp := getJobLog(t, srvURL, sessionCookie, "github", args[0], args[1])
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
		})
	}
	assert.Zero(t, source.lastJob, "the forge must not have been asked")
}

func TestJobLog_ErrorsNeverCarryTheUpstreamError(t *testing.T) {
	t.Parallel()

	const signed = "https://blob.example/log?sig=SECRETSIGNATURE"
	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, err: &url.Error{Op: "Get", URL: signed, Err: assert.AnError}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "SECRETSIGNATURE")
	assert.NotContains(t, string(raw), "blob.example")
	assert.NotEqual(t, http.StatusOK, resp.StatusCode)
}

func TestJobLog_ResponseIsNotCachedOrSniffed(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"a/b"}, log: dashboard.JobLog{Text: "x"}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, "no-store", resp.Header.Get("Cache-Control"))
	assert.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
}

func TestJobLog_ADotRepoLikeDotGithubIsAccepted(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"alrayyes/.github"}, log: dashboard.JobLog{Text: "ok\n"}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "alrayyes/.github", "7")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, ".github", source.lastName)
}

func TestJobLog_AConflictKindIsABadGatewayNotA409(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"a/b"}, err: &dashboard.ClientError{Kind: dashboard.ForgeErrorConflict, Err: assert.AnError}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
}

func TestJobLog_UntrackedRepo_Returns404AndNeverReachesTheForge(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"alrayyes/tempus-fugit"}, log: dashboard.JobLog{Text: "secret\n"}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "someone/private-thing", "4242")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
	assert.Empty(t, source.lastOwner, "the forge must not be called")
	assert.Zero(t, source.lastJob)
}

func TestJobLog_RepoNameCaseIsIgnoredWhenMatchingTrackedRepos(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, repos: []string{"alrayyes/tempus-fugit"}, log: dashboard.JobLog{Text: "ok\n"}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "AlRayyes/Tempus-Fugit", "4242")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusOK, resp.StatusCode)
}

func TestJobLog_NothingLoadedYet_Returns503AndNeverReachesTheForge(t *testing.T) {
	t.Parallel()

	source := &fakeJobLogSource{forge: dashboard.ForgeGitHub, log: dashboard.JobLog{Text: "secret\n"}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getJobLog(t, srvURL, sessionCookie, "github", "a/b", "1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
	var body struct {
		Error string `json:"error"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Contains(t, body.Error, "retry")
	assert.Empty(t, source.lastOwner, "the forge must not be called")
}
