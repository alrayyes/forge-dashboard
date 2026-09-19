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
// dashboard.PullRequestChecker directly — the shape github.Client and
// forgejo.Client both have.
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
