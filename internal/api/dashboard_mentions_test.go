package api_test

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// mentionsServer holds github alrayyes/a with issues 1 to 3 and pull requests
// 10 (closes 1, mentions 1, 2, 99 and another repo's 3), 11 (mentions 1 only)
// and 12 (mentions nothing), plus a Forgejo pull request that mentions an
// issue by its lowercased repo.
func mentionsServer(t *testing.T) (srvURL string, cookie *http.Cookie) {
	t.Helper()

	const token = "sekrit-token" // #nosec G101 -- a fake test fixture, not a real credential
	now := time.Now().UTC()
	pr := func(forge dashboard.Forge, repo string, n int, mod func(*dashboard.PullRequest)) dashboard.PullRequest {
		p := dashboard.PullRequest{
			Forge: forge, Repo: repo, Number: n, Title: "pr", CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
			Labels: []dashboard.Label{}, RequestedReviewerLogins: []string{}, CreatedAt: now, UpdatedAt: now,
		}
		if mod != nil {
			mod(&p)
		}

		return p
	}
	issue := func(forge dashboard.Forge, repo string, n int) dashboard.Issue {
		return dashboard.Issue{Forge: forge, Repo: repo, Number: n, Title: "issue", Labels: []dashboard.Label{}, CreatedAt: now, UpdatedAt: now}
	}
	ref := func(repo string, n int) dashboard.IssueRef {
		return dashboard.IssueRef{Repo: repo, Number: n, URL: "https://example.com/" + repo + "/issues/" + strconv.Itoa(n)}
	}
	github := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(dashboard.ForgeGitHub, "alrayyes/a", 10, func(p *dashboard.PullRequest) {
				p.ClosesIssues = []dashboard.IssueRef{ref("alrayyes/a", 1)}
				p.MentionsIssues = []dashboard.IssueRef{ref("alrayyes/a", 1), ref("alrayyes/a", 2), ref("alrayyes/a", 99), ref("other/repo", 3)}
			}),
			pr(dashboard.ForgeGitHub, "alrayyes/a", 11, func(p *dashboard.PullRequest) {
				p.MentionsIssues = []dashboard.IssueRef{ref("alrayyes/a", 1)}
			}),
			pr(dashboard.ForgeGitHub, "alrayyes/a", 12, nil),
		},
		issues: []dashboard.Issue{
			issue(dashboard.ForgeGitHub, "alrayyes/a", 1), issue(dashboard.ForgeGitHub, "alrayyes/a", 2), issue(dashboard.ForgeGitHub, "alrayyes/a", 3),
		},
		repos: []dashboard.Repo{{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a"}},
	}
	forgejo := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(dashboard.ForgeForgejo, "Ryan/Hush", 7, func(p *dashboard.PullRequest) {
				p.MentionsIssues = []dashboard.IssueRef{ref("ryan/hush", 3)}
			}),
			// A plain #3 in a mixed-case repo keeps the repo's own spelling.
			pr(dashboard.ForgeForgejo, "Ryan/Hush", 8, func(p *dashboard.PullRequest) {
				p.MentionsIssues = []dashboard.IssueRef{ref("Ryan/Hush", 3)}
			}),
		},
		issues: []dashboard.Issue{issue(dashboard.ForgeForgejo, "Ryan/Hush", 3)},
		repos:  []dashboard.Repo{{Forge: dashboard.ForgeForgejo, FullName: "Ryan/Hush", URL: "https://git.example.com/Ryan/Hush"}},
	}
	srv := newTestServerWithSources(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{github, forgejo}
	})
	cookie, _, _ = registerViaRealCeremony(t, srv)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "")["pullRequests"].([]any)

		return len(prs) == 5
	}, pollBudget, 10*time.Millisecond)

	return srv.URL, cookie
}

func listOf(t *testing.T, body map[string]any, kind, key, field string) []any {
	t.Helper()

	for _, raw := range body[kind].([]any) {
		item := raw.(map[string]any)
		if item["forge"].(string)+":"+item["repo"].(string)+"#"+strconv.Itoa(int(item["number"].(float64))) == key {
			list, ok := item[field].([]any)
			require.True(t, ok, "%s has no %s array", key, field)

			return list
		}
	}
	require.Failf(t, "not in the response", "%s", key)

	return nil
}

func numbers(list []any) []int {
	out := []int{}
	for _, e := range list {
		out = append(out, int(e.(map[string]any)["number"].(float64)))
	}

	return out
}

func TestDashboard_PullRequestsListTheTicketsTheyMention(t *testing.T) {
	t.Parallel()

	srvURL, cookie := mentionsServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "")

	t.Run("a ticket the pull request closes is not repeated", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "mentionsIssues")

		assert.Equal(t, []int{2, 99, 3}, numbers(got))
	})
	t.Run("a tracked issue carries the address that opens its dialog", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "mentionsIssues")[0].(map[string]any)

		assert.Equal(t, true, got["tracked"])
		assert.Equal(t, "/issues.html?issue=github/alrayyes/a/2", got["pageUrl"])
		assert.Equal(t, "https://example.com/alrayyes/a/issues/2", got["url"])
	})
	t.Run("an issue the dashboard does not hold is untracked, in this repo or another", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "github:alrayyes/a#10", "mentionsIssues")

		assert.Equal(t, false, got[1].(map[string]any)["tracked"])
		assert.Equal(t, false, got[2].(map[string]any)["tracked"])
	})
	t.Run("forgejo matches a lowercased repo against the mixed-case one", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "forgejo:Ryan/Hush#7", "mentionsIssues")[0].(map[string]any)

		assert.Equal(t, true, got["tracked"])
	})
	t.Run("a mention spelled in the repo's own case is tracked too", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "pullRequests", "forgejo:Ryan/Hush#8", "mentionsIssues")[0].(map[string]any)

		assert.Equal(t, true, got["tracked"])
	})
	t.Run("a pull request that mentions nothing lists none, never null", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, listOf(t, body, "pullRequests", "github:alrayyes/a#12", "mentionsIssues"))
	})
}

func TestDashboard_IssuesListThePullRequestsThatMentionThem(t *testing.T) {
	t.Parallel()

	srvURL, cookie := mentionsServer(t)
	body := fetchDashboardWith(t, srvURL, cookie, "")

	t.Run("a pull request that closes the issue is left to the closing list", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "issues", "github:alrayyes/a#1", "mentionedByPullRequests")

		assert.Equal(t, []int{11}, numbers(got))
	})
	t.Run("each carries the address that opens its dialog", func(t *testing.T) {
		t.Parallel()

		got := listOf(t, body, "issues", "github:alrayyes/a#2", "mentionedByPullRequests")

		require.Len(t, got, 1)
		assert.Equal(t, "/pull-requests.html?pr=github/alrayyes/a/10", got[0].(map[string]any)["pageUrl"])
	})
	t.Run("forgejo matches a lowercased repo against the mixed-case one", func(t *testing.T) {
		t.Parallel()

		assert.Equal(t, []int{7, 8}, numbers(listOf(t, body, "issues", "forgejo:Ryan/Hush#3", "mentionedByPullRequests")))
	})
	t.Run("an issue nothing mentions lists none, never null", func(t *testing.T) {
		t.Parallel()

		assert.Empty(t, listOf(t, body, "issues", "github:alrayyes/a#3", "mentionedByPullRequests"))
	})
}
