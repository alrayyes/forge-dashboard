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

// A self-hosted Forgejo under a path prefix keeps the prefix in its people's
// pages, and its deleted account (spelled "Ghost") has none.
func TestDashboard_AuthorURLKeepsAForgejosPathPrefix(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{
		forge: dashboard.ForgeForgejo,
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeForgejo, Repo: "team/app", Number: 3, URL: "https://host.example.org/forgejo/team/app/pulls/3", Author: "ryan"},
			{Forge: dashboard.ForgeForgejo, Repo: "team/app", Number: 4, URL: "https://host.example.org/forgejo/team/app/pulls/4", Author: "Ghost"},
		},
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

		return len(prs) == 2
	}, 2*time.Second, 10*time.Millisecond)

	urls := map[int]string{}
	for _, raw := range fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any) {
		item := raw.(map[string]any)
		urls[int(item["number"].(float64))], _ = item["authorUrl"].(string)
	}

	assert.Equal(t, map[int]string{3: "https://host.example.org/forgejo/ryan", 4: ""}, urls)
}

// A dialog's people hang off the web address of the repository it is about,
// not of the first item the board holds for that kind of forge: two
// self-hosted forges can both be Forgejo, and one can sit under a path prefix.
func TestPullRequestDetails_PeopleUseTheRepositorysOwnForge(t *testing.T) {
	t.Parallel()

	source := &fakeDetailerSource{
		forge: dashboard.ForgeForgejo,
		prs: []dashboard.PullRequest{
			{Forge: dashboard.ForgeForgejo, Repo: "team/other", Number: 1, URL: "https://first.example.org/team/other/pulls/1"},
			{Forge: dashboard.ForgeForgejo, Repo: "team/app", Number: 3, URL: "https://host.example.org/forgejo/team/app/pulls/3"},
		},
		details: sampleDetails(),
	}
	srvURL, sessionCookie := newTestServerForWebhookEnsure(t, dashboard.ForgeForgejo, source)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboard(t, srvURL, sessionCookie)["pullRequests"].([]any)

		return len(prs) == 2
	}, 2*time.Second, 10*time.Millisecond)

	resp := getPullRequestDetails(t, srvURL, sessionCookie, "forgejo", "team/app", 3)
	defer func() { _ = resp.Body.Close() }()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	var body struct {
		Comments []struct {
			Author map[string]any `json:"author"`
		} `json:"comments"`
	}
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Len(t, body.Comments, 1)
	assert.Equal(t, "https://host.example.org/forgejo/demo-a", body.Comments[0].Author["url"])
}
