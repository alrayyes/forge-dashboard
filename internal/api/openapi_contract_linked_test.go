package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Every issue lists the pull requests that will close it, always as an array,
// and the spec says what an entry is, so a client can rely on both.
func TestContract_IssuesCarryLinkedPullRequests(t *testing.T) {
	t.Parallel()

	t.Run("the spec requires linkedPullRequests and describes its entries", func(t *testing.T) {
		t.Parallel()

		doc, err := openapi3.NewLoader().LoadFromFile("../../api/openapi.yaml")
		require.NoError(t, err)
		issue := doc.Components.Schemas["Issue"].Value
		require.Contains(t, issue.Required, "linkedPullRequests")
		items := issue.Properties["linkedPullRequests"].Value.Items.Value

		assert.ElementsMatch(t, []string{"forge", "repo", "number", "draft", "pageUrl", "ci", "checks", "awaitingWorkflowApproval"}, items.Required)
	})
	t.Run("every issue in the response has the array, filled where a pull request closes it", func(t *testing.T) {
		t.Parallel()

		srv, cookie := linkedBoard(t)
		req, got := record(t, http.MethodGet, srv.URL+"/api/dashboard", cookie)
		require.Equal(t, http.StatusOK, got.status, string(got.body))
		validateAgainstSpec(t, req, got)

		var body struct {
			Issues []struct {
				Number             int `json:"number"`
				LinkedPullRequests []struct {
					Number  int    `json:"number"`
					Draft   bool   `json:"draft"`
					PageURL string `json:"pageUrl"`
				} `json:"linkedPullRequests"`
			} `json:"issues"`
		}
		require.NoError(t, json.Unmarshal(got.body, &body))
		require.Len(t, body.Issues, 2)
		for _, i := range body.Issues {
			require.NotNil(t, i.LinkedPullRequests, "issue %d", i.Number)
			if i.Number == 2 {
				require.Len(t, i.LinkedPullRequests, 1)
				assert.Equal(t, 5, i.LinkedPullRequests[0].Number)
				assert.Equal(t, "/pull-requests.html?pr=github/alrayyes/a/5", i.LinkedPullRequests[0].PageURL)
			} else {
				assert.Empty(t, i.LinkedPullRequests)
			}
		}
	})
}

func linkedBoard(t *testing.T) (*httptest.Server, *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	now := time.Now().UTC()
	src := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{{
			Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 5, Title: "Fix it", CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
			URL: "https://github.com/alrayyes/a/pull/5", Author: "alice", Labels: []dashboard.Label{},
			RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
			ClosesIssues: []dashboard.IssueRef{{Repo: "alrayyes/a", Number: 2, URL: "https://github.com/alrayyes/a/issues/2"}},
		}},
		issues: []dashboard.Issue{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 2, Title: "A real bug", URL: "https://github.com/alrayyes/a/issues/2", Author: "alice", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3, Title: "Another bug", URL: "https://github.com/alrayyes/a/issues/3", Author: "alice", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now},
		},
		repos: []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a"}},
	}
	srv := newTestServerWithSources(t, func(_ []byte, c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{src}
	})
	cookie, _, _ := registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(prs) == 1
	}, time.Second, 10*time.Millisecond)

	return srv, cookie
}
