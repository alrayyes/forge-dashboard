package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeCheckerSource implements both dashboard.Source and
// dashboard.PullRequestChecker directly — the shape github.Client has,
// since it drives its own Source. Forgejo's real shape is different (see
// TestPullRequestChecks_ForgejoViaGenericSource_ReturnsChecks below) —
// don't assume this fake alone exercises both forges' real wiring.
type fakeCheckerSource struct {
	forge      dashboard.Forge
	checks     []dashboard.Check
	checksErr  error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeCheckerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeCheckerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeCheckerSource) ListChecks(_ context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.checks, f.checksErr
}

func getPullRequestChecks(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	q := url.Values{
		"forge":    {forge},
		"fullName": {fullName},
		"number":   {strconv.Itoa(number)},
	}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/pull-requests/checks?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func TestPullRequestChecks_ReturnsEveryCheckForThePullRequest(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{
		forge: dashboard.ForgeGitHub,
		checks: []dashboard.Check{
			{Name: "build", State: dashboard.CheckSuccess, URL: "https://github.com/alrayyes/tempus-fugit/runs/1"},
			{Name: "test", State: dashboard.CheckRunning, URL: "https://github.com/alrayyes/tempus-fugit/runs/2"},
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)

	var body struct {
		Checks []dashboard.Check `json:"checks"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Checks, 2)
	assert.Equal(t, "build", body.Checks[0].Name)
	assert.Equal(t, dashboard.CheckSuccess, body.Checks[0].State)
}

func TestPullRequestChecks_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getPullRequestChecks(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestChecks_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestChecks(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestChecks_FetchFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{
		forge: dashboard.ForgeGitHub,
		checksErr: &dashboard.ClientError{
			Kind: dashboard.ForgeErrorUnauthorized,
			Err:  assert.AnError,
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestPullRequestChecks_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestChecks(t, srvURL, nil, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// fakeForgeClientWithChecker implements dashboard.ForgeClient plus
// PullRequestChecker — the real shape internal/forgejo.Client has, driven
// through dashboard.GenericSource rather than being a Source directly.
// #455: a fake Source implementing PullRequestChecker directly (like
// fakeCheckerSource above) never exercises GenericSource's own forwarding
// at all, which is exactly the gap that shipped a real "forgejo doesn't
// support listing pull request checks" regression despite forgejo.Client
// itself already implementing ListChecks correctly.
type fakeForgeClientWithChecker struct {
	checks     []dashboard.Check
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeForgeClientWithChecker) ListRepos(_ context.Context) ([]dashboard.RepoRef, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListOpenPullRequests(_ context.Context, _, _, _ string) ([]dashboard.PullRequest, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListOpenIssues(_ context.Context, _, _, _ string) ([]dashboard.Issue, error) {
	return nil, nil
}

func (f *fakeForgeClientWithChecker) ListChecks(_ context.Context, owner, name string, number int) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.checks, nil
}

func TestPullRequestChecks_ForgejoViaGenericSource_ReturnsChecks(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClientWithChecker{
		checks: []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess, URL: "https://git.example/runs/1"}},
	}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getPullRequestChecks(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 7)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", client.lastOwner)
	assert.Equal(t, "tempus-fugit", client.lastName)
	assert.Equal(t, 7, client.lastNumber)

	var body struct {
		Checks []dashboard.Check `json:"checks"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Checks, 1)
	assert.Equal(t, "build", body.Checks[0].Name)
}
