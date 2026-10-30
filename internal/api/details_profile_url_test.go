package api_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The people in a pull request's dialog carry their profile page, built from
// the web address of the forge the board already holds for that forge (#1991),
// so a dialog opened from a row needs no rule of its own.
func TestPullRequestDetails_PeopleCarryTheirProfileURL(t *testing.T) {
	t.Parallel()

	details := sampleDetails()
	details.Comments = append(details.Comments, dashboard.DetailsComment{ID: "c2", Author: nil, Text: "gone"})
	source := &fakeDetailerSource{
		forge: dashboard.ForgeGitHub,
		prs: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/tempus-fugit", Number: 42,
			URL: "https://github.com/alrayyes/tempus-fugit/pull/42",
		}},
		details: details,
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

		return len(prs) == 1
	}, pollBudget, 10*time.Millisecond)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Comments []struct {
			Author map[string]any `json:"author"`
		} `json:"comments"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	t.Run("a commenter", func(t *testing.T) {
		t.Parallel()

		require.Len(t, body.Comments, 2)
		assert.Equal(t, "https://github.com/demo-a", body.Comments[0].Author["url"])
	})
	t.Run("a deleted account has no author to link", func(t *testing.T) {
		t.Parallel()

		assert.Nil(t, body.Comments[1].Author)
	})
}

// With nothing on the board for the forge there is no web address to build
// on, so the people carry an empty url and the page shows their names alone.
func TestPullRequestDetails_NoBoardNoProfileURL(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, details: sampleDetails()}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "github", "alrayyes/tempus-fugit", 42)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Comments []struct {
			Author map[string]any `json:"author"`
		} `json:"comments"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Comments, 1)
	assert.Empty(t, body.Comments[0].Author["url"])
}

// Both dialogs' answers still match the spec once their people carry a url.
func TestContract_DetailsPeople(t *testing.T) {
	t.Parallel()

	t.Run("pull request", func(t *testing.T) {
		t.Parallel()

		source := &fakeDetailerSource{forge: dashboard.ForgeGitHub, details: sampleDetails()}
		srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

		req, got := record(t, http.MethodGet, srvURL+"/api/v1/pull-requests/details?forge=github&fullName=alrayyes/tempus-fugit&number=42", sessionCookie)

		require.Equal(t, http.StatusOK, got.status)
		validateAgainstSpec(t, req, got)
	})
	t.Run("issue", func(t *testing.T) {
		t.Parallel()

		source := &fakeIssueDetailerSource{forge: dashboard.ForgeGitHub, details: sampleIssueDetails()}
		srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeGitHub, source)

		req, got := record(t, http.MethodGet, srvURL+"/api/v1/issues/details?forge=github&fullName=alrayyes/tempus-fugit&number=3", sessionCookie)

		require.Equal(t, http.StatusOK, got.status)
		validateAgainstSpec(t, req, got)
	})
}
