package api_test

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type linkedEntry struct {
	Forge   string `json:"forge"`
	Repo    string `json:"repo"`
	Number  int    `json:"number"`
	Draft   bool   `json:"draft"`
	PageURL string `json:"pageUrl"`
	CI      string `json:"ci"`
	Checks  struct {
		Passed  int `json:"passed"`
		Running int `json:"running"`
		Waiting int `json:"waiting"`
		Failed  int `json:"failed"`
	} `json:"checks"`
	AwaitingWorkflowApproval bool `json:"awaitingWorkflowApproval"`
}

// linkedByIssue reads /api/dashboard and returns each issue's linked pull
// requests keyed "forge:repo#number".
func linkedByIssue(t *testing.T, srvURL string, cookie *http.Cookie) map[string][]linkedEntry {
	t.Helper()

	body := fetchDashboardWith(t, srvURL, cookie, "")
	out := map[string][]linkedEntry{}
	for _, raw := range body["issues"].([]any) {
		item := raw.(map[string]any)
		key := item["forge"].(string) + ":" + item["repo"].(string) + "#" + strconv.Itoa(int(item["number"].(float64)))
		list := []linkedEntry{}
		linked, ok := item["linkedPullRequests"].([]any)
		require.True(t, ok, "%s has no linkedPullRequests array", key)
		for _, l := range linked {
			m := l.(map[string]any)
			raw, err := json.Marshal(m)
			require.NoError(t, err)
			var entry linkedEntry
			require.NoError(t, json.Unmarshal(raw, &entry))
			list = append(list, entry)
		}
		out[key] = list
	}

	return out
}

func linkedServer(t *testing.T) (srvURL string, cookie *http.Cookie) {
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
	closes := func(repo string, n int) func(*dashboard.PullRequest) {
		return func(p *dashboard.PullRequest) { p.ClosesIssues = []dashboard.IssueRef{{Repo: repo, Number: n}} }
	}
	github := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2},
		prs: []dashboard.PullRequest{
			pr(dashboard.ForgeGitHub, "alrayyes/a", 20, func(p *dashboard.PullRequest) {
				p.CI = dashboard.CIPending
				p.Checks = dashboard.CheckCounts{Passed: 3, Running: 2, Failed: 1}
				p.AwaitingWorkflowApproval = true
				closes("alrayyes/a", 1)(p)
			}),
			pr(dashboard.ForgeGitHub, "alrayyes/a", 10, func(p *dashboard.PullRequest) { p.Draft = true; closes("alrayyes/a", 1)(p) }),
			pr(dashboard.ForgeGitHub, "alrayyes/a", 11, func(p *dashboard.PullRequest) {
				p.Labels = []dashboard.Label{{Name: "autorelease: pending"}}
				closes("alrayyes/a", 2)(p)
			}),
			pr(dashboard.ForgeGitHub, "alrayyes/ignored", 5, closes("alrayyes/a", 3)),
		},
		issues: []dashboard.Issue{
			issue(dashboard.ForgeGitHub, "alrayyes/a", 1), issue(dashboard.ForgeGitHub, "alrayyes/a", 2),
			issue(dashboard.ForgeGitHub, "alrayyes/a", 3), issue(dashboard.ForgeGitHub, "alrayyes/a", 4),
		},
		repos: []dashboard.Repo{
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/a", URL: "https://github.com/alrayyes/a"},
			{Forge: dashboard.ForgeGitHub, FullName: "alrayyes/ignored", URL: "https://github.com/alrayyes/ignored"},
		},
	}
	forgejo := &fakeConfiguredSource{
		health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true, RepoCount: 1},
		prs: []dashboard.PullRequest{
			pr(dashboard.ForgeForgejo, "Ryan/Hush", 7, func(p *dashboard.PullRequest) {
				p.CI = dashboard.CIFailure
				p.Checks = dashboard.CheckCounts{Passed: 4, Waiting: 1, Failed: 2}
				closes("ryan/hush", 3)(p)
			}),
		},
		issues: []dashboard.Issue{issue(dashboard.ForgeForgejo, "Ryan/Hush", 3), issue(dashboard.ForgeForgejo, "Ryan/Hush", 4)},
		repos:  []dashboard.Repo{{Forge: dashboard.ForgeForgejo, FullName: "Ryan/Hush", URL: "https://git.example.com/Ryan/Hush"}},
	}
	srv := newTestServerWithSources(t, func(c settingspkg.Credentials) []dashboard.Source {
		if c.GitHubToken != token {
			return nil
		}

		return []dashboard.Source{github, forgejo}
	})
	cookie, _, _ = registerViaRealCeremony(t, srv, testUser, testDisplay)
	resp := doJSON(t, http.MethodPut, srv.URL+"/api/settings", `{"githubToken":"`+token+`"}`, cookie)
	_ = resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Eventually(t, func() bool {
		prs, _ := fetchDashboardWith(t, srv.URL, cookie, "?includeDrafts=true")["pullRequests"].([]any)

		return len(prs) == 5
	}, pollBudget, 10*time.Millisecond)

	return srv.URL, cookie
}

// An issue lists the open pull requests that will close it, each with the
// address that opens its pop-up on the page that lists it.
func TestDashboard_IssuesListThePullRequestsThatWillCloseThem(t *testing.T) {
	t.Parallel()

	srvURL, cookie := linkedServer(t)

	t.Run("github: several, a draft among them, by number", func(t *testing.T) {
		// Drafts are off in this request: the pill still counts the draft.
		got := linkedByIssue(t, srvURL, cookie)["github:alrayyes/a#1"]

		assert.Equal(t, []linkedEntry{
			{Forge: "github", Repo: "alrayyes/a", Number: 10, Draft: true, PageURL: "/pull-requests.html?pr=github/alrayyes/a/10", CI: "success"},
			{Forge: "github", Repo: "alrayyes/a", Number: 20, PageURL: "/pull-requests.html?pr=github/alrayyes/a/20", CI: "pending", Checks: checkCounts(3, 2, 0, 1), AwaitingWorkflowApproval: true},
		}, got)
	})
	t.Run("github: a release pull request points at the releases page", func(t *testing.T) {
		got := linkedByIssue(t, srvURL, cookie)["github:alrayyes/a#2"]

		require.Len(t, got, 1)
		assert.Equal(t, "/releases.html?pr=github/alrayyes/a/11", got[0].PageURL)
	})
	t.Run("forgejo: a lowercased reference finds the mixed-case repo's issue", func(t *testing.T) {
		got := linkedByIssue(t, srvURL, cookie)

		assert.Equal(t, []linkedEntry{{Forge: "forgejo", Repo: "Ryan/Hush", Number: 7, PageURL: "/pull-requests.html?pr=forgejo/Ryan/Hush/7", CI: "failure", Checks: checkCounts(4, 0, 1, 2)}}, got["forgejo:Ryan/Hush#3"])
		assert.Equal(t, []linkedEntry{}, got["forgejo:Ryan/Hush#4"], "an issue nothing closes lists none, never null")
	})
	t.Run("a pull request in a repo whose pull requests are ignored is not listed", func(t *testing.T) {
		resp := postRepoIgnoreAction(t, srvURL, cookie, "alrayyes/ignored", true, false)
		_ = resp.Body.Close()
		require.Equal(t, http.StatusNoContent, resp.StatusCode)

		assert.Equal(t, []linkedEntry{}, linkedByIssue(t, srvURL, cookie)["github:alrayyes/a#3"])
	})
}

func checkCounts(passed, running, waiting, failed int) (c struct {
	Passed  int `json:"passed"`
	Running int `json:"running"`
	Waiting int `json:"waiting"`
	Failed  int `json:"failed"`
},
) {
	c.Passed, c.Running, c.Waiting, c.Failed = passed, running, waiting, failed

	return c
}
