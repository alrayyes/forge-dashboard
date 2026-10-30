package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeAdvisoryListerSource implements dashboard.Source and
// dashboard.AdvisoryLister directly, the shape the GitHub client has.
type fakeAdvisoryListerSource struct {
	forge     dashboard.Forge
	list      dashboard.AdvisoryList
	err       error
	lastOwner string
	lastName  string
	kind      apistats.Kind
}

func (f *fakeAdvisoryListerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeAdvisoryListerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeAdvisoryListerSource) ListAdvisories(ctx context.Context, owner, name string) (dashboard.AdvisoryList, error) {
	f.lastOwner, f.lastName = owner, name
	f.kind = apistats.KindFrom(ctx)

	return f.list, f.err
}

func getAdvisoryList(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {forge}, "fullName": {fullName}}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/main-branches/advisories?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func sampleAdvisoryList() dashboard.AdvisoryList {
	return dashboard.AdvisoryList{
		State: dashboard.AdvisoriesKnown, URL: "https://github.com/alrayyes/tempus-fugit/security/dependabot",
		Advisories: []dashboard.AdvisoryItem{{
			Number: 1, State: "open", Severity: dashboard.SeverityHigh, Summary: "A flaw",
			Package: "certifi", Ecosystem: "pip", Scope: "runtime", Relationship: "direct", ManifestPath: "uv.lock",
			OpenedAt: "2026-10-21T14:12:00Z", URL: "https://github.com/alrayyes/tempus-fugit/security/dependabot/1",
		}},
	}
}

func TestAdvisoryList_ReturnsTheOpenAdvisories(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub, list: sampleAdvisoryList()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getAdvisoryList(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, apistats.KindAdvisories, source.kind)
	var body struct {
		State      string           `json:"state"`
		Advisories []map[string]any `json:"advisories"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "known", body.State)
	require.Len(t, body.Advisories, 1)
	assert.Equal(t, "certifi", body.Advisories[0]["package"])
}

func TestAdvisoryList_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getAdvisoryList(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestAdvisoryList_MalformedName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getAdvisoryList(t, srvURL, sessionCookie, "github", "not-owner-slash-repo")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestAdvisoryList_FetchFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{
		forge: dashboard.ForgeGitHub,
		err:   &dashboard.ClientError{Kind: dashboard.ForgeErrorUnreachable, Err: assert.AnError},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getAdvisoryList(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
}

func TestAdvisoryList_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getAdvisoryList(t, srvURL, nil, "github", "alrayyes/a")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestContract_AdvisoryList(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeGitHub, list: sampleAdvisoryList()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/main-branches/advisories?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
}

func TestAdvisoryList_ForgejoLister_ReturnsOSVMatchesAndPartial(t *testing.T) {
	t.Parallel()

	source := &fakeAdvisoryListerSource{forge: dashboard.ForgeForgejo, list: dashboard.AdvisoryList{
		State: dashboard.AdvisoriesKnown, Partial: true,
		Advisories: []dashboard.AdvisoryItem{{
			Number: 1, State: "open", ID: "GHSA-aaaa-bbbb-cccc", Severity: dashboard.SeverityHigh, Summary: "A flaw",
			Package: "lodash@4.17.0", Ecosystem: "npm", ManifestPath: "package-lock.json",
			PatchedVersion: "4.17.21", URL: "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc",
		}},
	}}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getAdvisoryList(t, srvURL, sessionCookie, "forgejo", "acme/lockfiles")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "acme", source.lastOwner)
	assert.Equal(t, "lockfiles", source.lastName)
	assert.Equal(t, apistats.KindAdvisories, source.kind)
	var body struct {
		State      string           `json:"state"`
		Partial    bool             `json:"partial"`
		Advisories []map[string]any `json:"advisories"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "known", body.State)
	assert.True(t, body.Partial)
	require.Len(t, body.Advisories, 1)
	assert.Equal(t, "GHSA-aaaa-bbbb-cccc", body.Advisories[0]["id"])
	assert.Equal(t, "https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc", body.Advisories[0]["url"])
}
