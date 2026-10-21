package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeBranchCheckerSource implements dashboard.Source and
// dashboard.DefaultBranchChecker directly, the shape github.Client has.
type fakeBranchCheckerSource struct {
	forge     dashboard.Forge
	checks    []dashboard.Check
	checksErr error
	lastOwner string
	lastName  string
}

func (f *fakeBranchCheckerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeBranchCheckerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeBranchCheckerSource) ListDefaultBranchChecks(_ context.Context, owner, name string) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName = owner, name

	return f.checks, f.checksErr
}

func getMainBranchChecks(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {forge}, "fullName": {fullName}}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/main-branches/checks?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func TestMainBranchChecks_ReturnsEveryCheckOfTheDefaultBranch(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{
		forge: dashboard.ForgeGitHub,
		checks: []dashboard.Check{
			{Name: "build", State: dashboard.CheckSuccess, URL: "https://github.com/alrayyes/tempus-fugit/runs/1"},
			{Name: "test", State: dashboard.CheckRunning, URL: "https://github.com/alrayyes/tempus-fugit/runs/2"},
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)

	var body struct {
		Checks []dashboard.Check `json:"checks"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Checks, 2)
	assert.Equal(t, "build", body.Checks[0].Name)
	assert.Equal(t, dashboard.CheckRunning, body.Checks[1].State)
}

func TestMainBranchChecks_NoChecks_ReturnsAnEmptyArray(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body map[string]json.RawMessage
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.JSONEq(t, `[]`, string(body["checks"]))
}

func TestMainBranchChecks_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestMainBranchChecks_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "github", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestMainBranchChecks_FetchFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{
		forge:     dashboard.ForgeGitHub,
		checksErr: &dashboard.ClientError{Kind: dashboard.ForgeErrorUnauthorized, Err: assert.AnError},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusForbidden, resp.StatusCode)
}

func TestMainBranchChecks_FetchFails_MapsNotFoundAndRateLimit(t *testing.T) {
	t.Parallel()

	for kind, want := range map[dashboard.ForgeErrorKind]int{
		dashboard.ForgeErrorNotFound:    http.StatusNotFound,
		dashboard.ForgeErrorRateLimited: http.StatusTooManyRequests,
	} {
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()

			source := &fakeBranchCheckerSource{
				forge:     dashboard.ForgeGitHub,
				checksErr: &dashboard.ClientError{Kind: kind, Err: assert.AnError},
			}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := getMainBranchChecks(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, want, resp.StatusCode)
		})
	}
}

func TestMainBranchChecks_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeBranchCheckerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getMainBranchChecks(t, srvURL, nil, "github", "alrayyes/a")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// fakeForgeClientWithBranchChecker is the real shape internal/forgejo.Client
// has, driven through dashboard.GenericSource, so the Source's own forwarding
// is exercised too.
type fakeForgeClientWithBranchChecker struct {
	fakeForgeClientWithChecker
}

func (f *fakeForgeClientWithBranchChecker) ListDefaultBranchChecks(_ context.Context, owner, name string) ([]dashboard.Check, error) {
	f.lastOwner, f.lastName = owner, name

	return f.checks, nil
}

func TestMainBranchChecks_ForgejoViaGenericSource_ReturnsChecks(t *testing.T) {
	t.Parallel()

	client := &fakeForgeClientWithBranchChecker{}
	client.checks = []dashboard.Check{{Name: "build", State: dashboard.CheckSuccess, URL: "https://git.example/runs/1"}}
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, 4)
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getMainBranchChecks(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "tempus-fugit", client.lastName)
}
