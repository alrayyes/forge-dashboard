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

// fakeReleaseDetailerSource implements dashboard.Source and
// dashboard.ReleaseDetailer directly, the shape the GitHub client has.
type fakeReleaseDetailerSource struct {
	forge      dashboard.Forge
	details    dashboard.ReleaseDetails
	detailsErr error
	lastOwner  string
	lastName   string
	lastTag    string
}

func (f *fakeReleaseDetailerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeReleaseDetailerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}}
}

func (f *fakeReleaseDetailerSource) GetReleaseDetails(_ context.Context, owner, name, tag string) (dashboard.ReleaseDetails, error) {
	f.lastOwner, f.lastName, f.lastTag = owner, name, tag

	return f.details, f.detailsErr
}

func getReleaseDetails(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName, tag string) *http.Response {
	t.Helper()
	q := url.Values{"forge": {forge}, "fullName": {fullName}, "tag": {tag}}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/releases/details?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func sampleReleaseDetails() dashboard.ReleaseDetails {
	none := dashboard.Reaction{Logins: []string{}}

	return dashboard.ReleaseDetails{
		Tag: "v1.2.3", Name: "Spring cleaning", URL: "https://github.com/alrayyes/tempus-fugit/releases/tag/v1.2.3",
		PublishedAt: "2026-10-01T10:00:00Z",
		Notes: dashboard.DetailsBody{
			Text: "## Fixes\n- The page keeps its place.", Format: dashboard.FormatMarkdown,
			Reactions: dashboard.Reactions{ThumbsUp: dashboard.Reaction{Count: 1, Logins: []string{"demo-a"}}, ThumbsDown: none},
		},
	}
}

func TestReleaseDetails_ReturnsTheTitleAndTheNotes(t *testing.T) {
	t.Parallel()

	source := &fakeReleaseDetailerSource{forge: dashboard.ForgeGitHub, details: sampleReleaseDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getReleaseDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", "v1.2.3")
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, "v1.2.3", source.lastTag)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "Spring cleaning", body["name"])
	notes, ok := body["notes"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "markdown", notes["format"])
}

func TestReleaseDetails_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getReleaseDetails(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", "v1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestReleaseDetails_MalformedInput_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeReleaseDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	badName := getReleaseDetails(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", "v1")
	defer func() { _ = badName.Body.Close() }()
	noTag := getReleaseDetails(t, srvURL, sessionCookie, "github", "alrayyes/a", "")
	defer func() { _ = noTag.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, badName.StatusCode)
	assert.Equal(t, http.StatusBadRequest, noTag.StatusCode)
}

func TestReleaseDetails_FetchFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		kind dashboard.ForgeErrorKind
		want int
	}{
		"not found":    {dashboard.ForgeErrorNotFound, http.StatusNotFound},
		"rate limited": {dashboard.ForgeErrorRateLimited, http.StatusTooManyRequests},
		"unreachable":  {dashboard.ForgeErrorUnreachable, http.StatusBadGateway},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			source := &fakeReleaseDetailerSource{
				forge:      dashboard.ForgeGitHub,
				detailsErr: &dashboard.ClientError{Kind: tc.kind, Err: assert.AnError},
			}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := getReleaseDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", "v1")
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.want, resp.StatusCode)
		})
	}
}

func TestReleaseDetails_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeReleaseDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getReleaseDetails(t, srvURL, nil, "github", "alrayyes/a", "v1")
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestContract_ReleaseDetails(t *testing.T) {
	t.Parallel()

	source := &fakeReleaseDetailerSource{forge: dashboard.ForgeGitHub, details: sampleReleaseDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "tag": {"v1.2.3"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/releases/details?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
}
