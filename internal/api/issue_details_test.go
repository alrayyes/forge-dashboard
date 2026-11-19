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
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeIssueDetailerSource implements dashboard.Source and
// dashboard.IssueDetailer directly, the shape github.Client has.
type fakeIssueDetailerSource struct {
	forge      dashboard.Forge
	issues     []dashboard.Issue
	details    dashboard.IssueDetails
	detailsErr error
	lastOwner  string
	lastName   string
	lastNumber int
}

func (f *fakeIssueDetailerSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeIssueDetailerSource) Fetch(_ context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true}, Issues: f.issues}
}

func (f *fakeIssueDetailerSource) GetIssueDetails(_ context.Context, owner, name string, number int) (dashboard.IssueDetails, error) {
	f.lastOwner, f.lastName, f.lastNumber = owner, name, number

	return f.details, f.detailsErr
}

func getIssueDetails(t *testing.T, srvURL string, sessionCookie *http.Cookie, forge, fullName string, number int) *http.Response {
	t.Helper()
	q := url.Values{
		"forge":    {forge},
		"fullName": {fullName},
		"number":   {strconv.Itoa(number)},
	}
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/issues/details?"+q.Encode(), nil)
	require.NoError(t, err)
	if sessionCookie != nil {
		req.AddCookie(sessionCookie)
	}
	resp, err := testClient(t).Do(req)
	require.NoError(t, err)

	return resp
}

func sampleIssueDetails() dashboard.IssueDetails {
	none := dashboard.Reaction{Logins: []string{}}

	return dashboard.IssueDetails{
		Kind:  dashboard.ItemKindIssue,
		State: dashboard.IssueStateClosed,
		Description: dashboard.DetailsBody{
			Text: "The page loses its place.", Format: dashboard.FormatMarkdown,
			Reactions: dashboard.Reactions{ThumbsUp: dashboard.Reaction{Count: 2, Logins: []string{"demo-a", "demo-b"}}, ThumbsDown: none},
		},
		Comments: []dashboard.DetailsComment{{
			ID: "c1", Author: &dashboard.Person{Login: "demo-a", AvatarURL: "https://avatars.example.com/u/1"},
			CreatedAt: "2026-10-01T10:00:00Z", Text: "Seen it too.", Format: dashboard.FormatMarkdown,
			Reactions: dashboard.Reactions{ThumbsUp: none, ThumbsDown: none},
		}},
		CommentCount: 1,
	}
}

func TestIssueDetails_ReturnsTheDescriptionAndTheConversation(t *testing.T) {
	t.Parallel()

	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: sampleIssueDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getIssueDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, "alrayyes", source.lastOwner)
	assert.Equal(t, "tempus-fugit", source.lastName)
	assert.Equal(t, 42, source.lastNumber)
	var body map[string]any
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	description, ok := body["description"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "The page loses its place.", description["text"])
	assert.Equal(t, "markdown", description["format"])
	comments, ok := body["comments"].([]any)
	require.True(t, ok)
	require.Len(t, comments, 1)
	assert.Equal(t, "closed", body["state"])
	assert.EqualValues(t, 1, body["commentCount"])
	assert.Equal(t, false, body["commentsTruncated"])
	assert.NotContains(t, body, "releaseNotes", "an issue has no release notes")
}

func TestIssueDetails_ForgeWithNoSupport_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeSourceWithoutBranchUpdateSupport{forge: dashboard.ForgeForgejo}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)

	resp := getIssueDetails(t, srvURL, sessionCookie, "forgejo", "alrayyes/tempus-fugit", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestIssueDetails_MalformedInput_Returns400(t *testing.T) {
	t.Parallel()

	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	badName := getIssueDetails(t, srvURL, sessionCookie, "github", "not-owner-slash-repo", 1)
	defer func() { _ = badName.Body.Close() }()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/api/v1/issues/details?forge=github&fullName=alrayyes/a&number=abc", nil)
	require.NoError(t, err)
	req.AddCookie(sessionCookie)
	badNumber, err := testClient(t).Do(req)
	require.NoError(t, err)
	defer func() { _ = badNumber.Body.Close() }()

	assert.Equal(t, http.StatusBadRequest, badName.StatusCode)
	assert.Equal(t, http.StatusBadRequest, badNumber.StatusCode)
}

// The forge refusing, rate-limiting or being unreachable is an error with the
// code the page already reads, never an empty thread.
func TestIssueDetails_FetchFails_ClassifiesByError(t *testing.T) {
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

			source := &fakeIssueDetailerSource{
				forge:      dashboard.ForgeGitHub,
				detailsErr: &dashboard.ClientError{Kind: tc.kind, Err: assert.AnError},
			}
			srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

			resp := getIssueDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 1)
			defer func() { _ = resp.Body.Close() }()

			assert.Equal(t, tc.want, resp.StatusCode)
		})
	}
}

func TestIssueDetails_Unauthenticated_Returns401(t *testing.T) {
	t.Parallel()

	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub}
	srvURL, _ := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getIssueDetails(t, srvURL, nil, "github", "alrayyes/a", 1)
	defer func() { _ = resp.Body.Close() }()

	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

// The real answer matches the document, including a deleted author (null) and
// a comment that was edited.
func TestContract_IssueDetails(t *testing.T) {
	t.Parallel()

	none := dashboard.Reaction{Logins: []string{}}
	edited := "2026-10-01T11:30:00Z"
	details := sampleIssueDetails()
	details.Comments = append(details.Comments, dashboard.DetailsComment{
		ID: "c2", Author: nil, CreatedAt: "2026-10-01T11:00:00Z", UpdatedAt: &edited, Edited: true,
		Text: "A deleted account's note.", Format: dashboard.FormatMarkdown,
		Reactions: dashboard.Reactions{ThumbsUp: none, ThumbsDown: dashboard.Reaction{Count: 12, Logins: []string{"demo-a"}}},
	})
	details.CommentCount = 70
	details.CommentsTruncated = true
	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: details}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "number": {"7"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/issues/details?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
}

// What refers to an issue is read from the forge, so a closed one has it too
// (#4271). Each entry gets the address that opens it on this dashboard, and an
// issue nothing refers to answers an empty list, never null.
func TestIssueDetails_ReferencesCarryTheirDashboardAddress(t *testing.T) {
	t.Parallel()

	details := sampleIssueDetails()
	details.References = []dashboard.ItemReference{
		{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 12, Title: "Fix it",
			URL: "https://github.com/alrayyes/tempus-fugit/pull/12", Kind: dashboard.ItemKindPullRequest,
			State: dashboard.ReferencedStateMerged, Direction: dashboard.ReferenceIncoming, Relation: dashboard.RelationCloses,
		},
		{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/other", Number: 3, Title: "Follow-up",
			URL: "https://github.com/alrayyes/other/issues/3", Kind: dashboard.ItemKindIssue,
			State: dashboard.ReferencedStateClosed, Direction: dashboard.ReferenceIncoming, Relation: dashboard.RelationMentions,
		},
	}
	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: details}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "number": {"7"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/issues/details?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
	var body struct {
		References []map[string]any `json:"references"`
	}
	require.NoError(t, json.Unmarshal(got.body, &body))
	require.Len(t, body.References, 2)
	assert.Equal(t, "/pull-requests.html?pr=github/alrayyes/tempus-fugit/12", body.References[0]["pageUrl"])
	assert.Equal(t, "/issues.html?issue=github/alrayyes/other/3", body.References[1]["pageUrl"])
	assert.Equal(t, "incoming", body.References[0]["direction"])
	assert.Equal(t, "closes", body.References[0]["relation"])
	assert.Equal(t, "merged", body.References[0]["state"])
}

// The most one read returns is every incoming reference the forge's timeline
// gives (50) plus every outgoing one the text names (20), so the contract's
// bound has to hold both (#4272).
func TestContract_IssueDetailsHoldsIncomingAndOutgoingReferences(t *testing.T) {
	t.Parallel()

	details := sampleIssueDetails()
	for i := 1; i <= dashboard.MaxReferences+dashboard.MaxOutgoingReferences; i++ {
		direction := dashboard.ReferenceIncoming
		if i > dashboard.MaxReferences {
			direction = dashboard.ReferenceOutgoing
		}
		details.References = append(details.References, dashboard.ItemReference{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/other", Number: i, Title: "Item",
			URL: "https://github.com/alrayyes/other/issues/1", Kind: dashboard.ItemKindIssue,
			State: dashboard.ReferencedStateOpen, Direction: direction, Relation: dashboard.RelationRefs,
		})
	}
	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: details}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "number": {"7"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/issues/details?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
}

func TestIssueDetails_NothingReferringIsAnEmptyList(t *testing.T) {
	t.Parallel()

	source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: sampleIssueDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	q := url.Values{"forge": {"github"}, "fullName": {"alrayyes/tempus-fugit"}, "number": {"7"}}
	req, got := record(t, http.MethodGet, srvURL+"/api/v1/issues/details?"+q.Encode(), sessionCookie)

	require.Equal(t, http.StatusOK, got.status, string(got.body))
	validateAgainstSpec(t, req, got)
	assert.Contains(t, string(got.body), `"references":[]`)
}

// A commenter in an issue's dialog carries their profile page, built on the
// web address of an issue the board holds for the forge (#1991).
func TestIssueDetails_CommentersCarryTheirProfileURL(t *testing.T) {
	t.Parallel()

	source := &fakeIssueDetailerSource{
		forge: dashboard.ForgeForgejo,
		issues: []dashboard.Issue{{
			Forge: dashboard.ForgeForgejo, Repo: "team/app", Number: 5,
			URL: "https://git.example.org/team/app/issues/5",
		}},
		details: sampleIssueDetails(),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	require.Eventually(t, func() bool {
		issues, _ := fetchDashboard(t, srvURL, sessionCookie)["issues"].([]any)

		return len(issues) == 1
	}, pollBudget, 10*time.Millisecond)

	resp := getIssueDetails(t, srvURL, sessionCookie, "forgejo", "team/app", 5)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Comments []struct {
			Author map[string]any `json:"author"`
		} `json:"comments"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Comments, 1)
	assert.Equal(t, "https://git.example.org/demo-a", body.Comments[0].Author["url"])
}

// The author of a pull request found through a reference links to their
// profile the way a commenter does, so the page never builds an address.
func TestIssueDetails_APullRequestAuthorCarriesTheirProfileURL(t *testing.T) {
	t.Parallel()

	details := sampleIssueDetails()
	details.Kind = dashboard.ItemKindPullRequest
	details.PullRequest = &dashboard.IssuePullRequest{
		Title: "Add structured logging", State: dashboard.ReferencedStateMerged,
		Author: &dashboard.Person{Login: "demo-a", AvatarURL: "https://avatars.example.com/u/1"},
	}
	source := &fakeIssueDetailerSource{
		forge: dashboard.ForgeForgejo,
		issues: []dashboard.Issue{{
			Forge: dashboard.ForgeForgejo, Repo: "team/app", Number: 5,
			URL: "https://git.example.org/team/app/issues/5",
		}},
		details: details,
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	require.Eventually(t, func() bool {
		issues, _ := fetchDashboard(t, srvURL, sessionCookie)["issues"].([]any)

		return len(issues) == 1
	}, pollBudget, 10*time.Millisecond)

	resp := getIssueDetails(t, srvURL, sessionCookie, "forgejo", "team/app", 5)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		PullRequest struct {
			Title  string         `json:"title"`
			State  string         `json:"state"`
			Author map[string]any `json:"author"`
		} `json:"pullRequest"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	assert.Equal(t, "Add structured logging", body.PullRequest.Title)
	assert.Equal(t, "merged", body.PullRequest.State)
	assert.Equal(t, "https://git.example.org/demo-a", body.PullRequest.Author["url"])
}

// The page picks its dialog from kind, so a response without one is a broken
// contract: the spec must keep it required, with exactly these two values.
func TestContract_IssueDetailsKindIsRequired(t *testing.T) {
	t.Parallel()

	doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
	require.NoError(t, err)
	schema := doc.Components.Schemas["IssueDetails"].Value

	assert.Contains(t, schema.Required, "kind")
	assert.Equal(t, []any{"issue", "pullRequest"}, schema.Properties["kind"].Value.Enum)
}
