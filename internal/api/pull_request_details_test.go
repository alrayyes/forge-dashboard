package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeDetailerSource implements dashboard.Source and dashboard.PullRequestDetailer
// directly, the shape github.Client has. Its Fetch lists prs, so a test can put a
// pull request of a given kind on the board.
type fakeDetailerSource struct {
	forge      dashboard.Forge
	prs        []dashboard.PullRequest
	details    dashboard.PullRequestDetails
	detailsErr error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeDetailerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeDetailerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}, PullRequests: f.prs}
}

func (f *fakeDetailerSource) GetPullRequestDetails(_ context.Context, owner, name string, number int) (dashboard.PullRequestDetails, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.details, f.detailsErr
}

func getPullRequestDetails(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	q := url.Values{
		"forge":    {forge},
		"fullName": {fullName},
		"number":   {strconv.Itoa(number)},
	}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/pull-requests/details?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)

	return resp
}

func sampleDetails() dashboard.PullRequestDetails {
	none := dashboard.Reaction{Logins: []string{}}

	return dashboard.PullRequestDetails{
		Description: dashboard.DetailsBody{
			Text: "Adds the dialog.", Format: dashboard.FormatMarkdown,
			Reactions: dashboard.Reactions{ThumbsUp: dashboard.Reaction{Count: 2, Logins: []string{"demo-a", "demo-b"}}, ThumbsDown: none},
		},
		Comments: []dashboard.DetailsComment{{
			ID: "c1", Author: &dashboard.Person{Login: "demo-a", AvatarURL: "https://avatars.example.com/u/1"},
			CreatedAt: "2026-10-01T10:00:00Z", Text: "Looks good.", Format: dashboard.FormatMarkdown,
			Reactions: dashboard.Reactions{ThumbsUp: none, ThumbsDown: none},
		}},
		CommentCount: 1,
	}
}

func TestPullRequestDetails_ReturnsTheDescriptionAndTheConversation(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, details: sampleDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	description, ok := body["description"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "Adds the dialog.", description["text"])
	assert.Equal(t, "markdown", description["format"])
	comments, ok := body["comments"].([]any)
	require.True(t, ok)
	require.Len(t, comments, 1)
	assert.EqualValues(t, 1, body["commentCount"])
	assert.Equal(t, false, body["commentsTruncated"])
	assert.Contains(t, body, "releaseNotes", "always present")
	assert.Nil(t, body["releaseNotes"], "a pull request that isn't a release has no release notes")
}

// A release-please pull request's description is the changelog it publishes, so
// that is its release notes (#1506). It is found by the board's own kind rule,
// not a second copy of it.
func TestPullRequestDetails_AReleasePullRequestCarriesItsReleaseNotes(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{
		forge: dashboard.ForgeGitHub,
		prs: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, Title: "chore(main): release 1.2.0",
			Labels: []dashboard.Label{{Name: "autorelease: pending"}},
		}},
		details: sampleDetails(),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

		return len(prs) == 1
	}, 2*time.Second, 10*time.Millisecond)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 7)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	notes, ok := body["releaseNotes"].(map[string]any)
	require.True(t, ok, "a release pull request carries release notes")
	assert.Equal(t, "Adds the dialog.", notes["text"])
}

// The board lists the pull request, but it isn't a release one, or it is and
// has nothing written: either way there are no release notes to show.
func TestPullRequestDetails_ListedButNoReleaseNotes(t *testing.T) {
	t.Parallel()

	cases := map[string]struct {
		pr   dashboard.PullRequest
		body string
	}{
		"a listed pull request that isn't a release": {
			pr: dashboard.PullRequest{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, Title: "feat: a dialog",
			},
			body: "Adds the dialog.",
		},
		"a release pull request with an empty description": {
			pr: dashboard.PullRequest{
				Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7, Title: "chore(main): release 1.2.0",
				Labels: []dashboard.Label{{Name: "autorelease: pending"}},
			},
			body: "",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			details := sampleDetails()
			details.Description.Text = tc.body
			source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, prs: []dashboard.PullRequest{tc.pr}, details: details}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
			require.Eventually(t, func() bool {
				prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

				return len(prs) == 1
			}, 2*time.Second, 10*time.Millisecond)

			resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 7)
			defer func() { _ = resp.Body.Close() }()

			require.Equal(t, http.StatusOK, resp.StatusCode)
			var body map[string]any
			require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
			assert.Nil(t, body["releaseNotes"])
		})
	}
}

func TestPullRequestDetails_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestPullRequestDetails_MalformedFullName_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

// The forge refusing, rate-limiting or being unreachable is an error with the
// code the page already reads, never an empty thread (#1506).
func TestPullRequestDetails_FetchFails_ClassifiesByError(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		kind dashboard.ForgeErrorKind
		want int
	}{
		"unauthorized": {dashboard.ForgeErrorUnauthorized, http.StatusForbidden},
		"not found":    {dashboard.ForgeErrorNotFound, http.StatusNotFound},
		"rate limited": {dashboard.ForgeErrorRateLimited, http.StatusTooManyRequests},
		"unreachable":  {dashboard.ForgeErrorUnreachable, http.StatusBadGateway},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			source := &fakeDetailerSource{
				forge:      dashboard.ForgeGitHub,
				detailsErr: &dashboard.ClientError{Kind: tc.kind, Err: assert.AnError},
			}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.want, resp.StatusCode)
		})
	}
}

func TestPullRequestDetails_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestDetails(t, srvURL, nil, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// The real answers match the document, including a deleted author (null), a
// comment that was edited and one that never was, and a release pull request's
// release notes (#1506).
func TestContract_PullRequestDetails(t *testing.T) {
	t.Parallel()

	none := dashboard.Reaction{Logins: []string{}}
	edited := "2026-10-01T11:30:00Z"
	details := sampleDetails()
	details.Comments = append(details.Comments, dashboard.DetailsComment{
		ID: "c2", Author: nil, CreatedAt: "2026-10-01T11:00:00Z", UpdatedAt: &edited, Edited: true,
		Text: "A deleted account's note.", Format: dashboard.FormatMarkdown,
		Reactions: dashboard.Reactions{ThumbsUp: none, ThumbsDown: dashboard.Reaction{Count: 12, Logins: []string{"demo-a"}}},
	})
	details.CommentCount = 70
	details.CommentsTruncated = true
	source := &fakeDetailerSource{
		forge: dashboard.ForgeGitHub,
		prs: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 7,
			Labels: []dashboard.Label{{Name: "autorelease: pending"}},
		}},
		details: details,
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

		return len(prs) == 1
	}, 2*time.Second, 10*time.Millisecond)

	for _, number := range []int{7, 8} { // a release pull request, and one the board doesn't list
		q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "number": {strconv.Itoa(number)}}
		req, got := record(t, http.MethodGet, srvURL+"/api/pull-requests/details?"+q.Encode(), sessionCookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)
	}
}
