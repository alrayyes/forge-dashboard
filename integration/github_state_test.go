//go:build ghfixture

// Compares the dashboard's view of every pull request in the GitHub fixture
// repo (alrayyes/forge-dashboard-e2e-fixture, built by scripts/e2e-fixture/)
// with what GitHub itself says (#950). GitHub's side is asked through
// `gh api graphql`, not through this app's client, so the two share no code.
//
//	GITHUB_TOKEN=$(gh auth token) go test -tags ghfixture -run TestGitHubState -v ./integration/
//
// Needs the fixture built, its checks finished, and gh logged in as the repo
// owner. It's a separate tag from `integration`: that one needs Docker, this one
// needs the network and a token, and neither belongs in `go test ./...`.
package integration

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/require"
)

const (
	fixtureOwner = "alrayyes"
	fixtureRepo  = "forge-dashboard-e2e-fixture"
)

// knownDisagreements lists scenarios where the dashboard and GitHub differ,
// by scenario title and the ticket (or reason) that tracks each. The
// test fails on a listed scenario that now agrees, so the entry gets removed
// with the fix instead of rotting.
var knownDisagreements = map[string]string{}

// githubTruth is what GitHub says about one pull request.
type githubTruth struct {
	Number              int       `json:"number"`
	Title               string    `json:"title"`
	IsDraft             bool      `json:"isDraft"`
	Mergeable           string    `json:"mergeable"`
	MergeStateStatus    string    `json:"mergeStateStatus"`
	ReviewDecision      string    `json:"reviewDecision"`
	ViewerCanMergeAdmin bool      `json:"viewerCanMergeAsAdmin"`
	AutoMergeRequest    *struct{} `json:"autoMergeRequest"`
}

const truthQuery = `query { repository(owner:"` + fixtureOwner + `", name:"` + fixtureRepo + `") {
  pullRequests(states:OPEN, first:100) { nodes {
    number title isDraft mergeable mergeStateStatus reviewDecision viewerCanMergeAsAdmin autoMergeRequest{mergeMethod}
  } } } }`

func fetchTruth(t *testing.T) map[int]githubTruth {
	t.Helper()
	out, err := exec.Command("gh", "api", "graphql", "-f", "query="+truthQuery).Output()
	require.NoError(t, err, "gh api graphql")
	var resp struct {
		Data struct {
			Repository struct {
				PullRequests struct {
					Nodes []githubTruth `json:"nodes"`
				} `json:"pullRequests"`
			} `json:"repository"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(out, &resp))
	truth := map[int]githubTruth{}
	for _, n := range resp.Data.Repository.PullRequests.Nodes {
		truth[n.Number] = n
	}

	return truth
}

// githubMergeable is GitHub's own answer to "can the merge button be pressed
// by anyone": the state says so and the PR isn't a draft. admin adds the
// owner's "merge without waiting for requirements" bypass.
func (g githubTruth) githubMergeable() bool {
	switch g.MergeStateStatus {
	case "CLEAN", "UNSTABLE", "HAS_HOOKS":
		return !g.IsDraft
	}

	return false
}

func dashboardMergeAllowed(pr dashboard.PullRequest) (bool, string) {
	for _, a := range dashboard.AllowedActions(pr) {
		if a.Action == dashboard.ActionMerge {
			if a.Blocked != nil {
				return false, string(a.Blocked.Code) + ": " + a.Blocked.Message
			}

			return true, ""
		}
	}

	return false, "no merge action"
}

func TestGitHubState_DashboardAgreesWithGitHub(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}

	truth := fetchTruth(t)
	require.NotEmpty(t, truth, "fixture has no open pull requests; run scripts/e2e-fixture/build.sh")
	for _, g := range truth {
		require.NotEqual(t, "UNKNOWN", g.MergeStateStatus, "#%d is still being computed by GitHub; rerun in a minute", g.Number)
	}

	client := github.NewClient(token, "", "")
	prs, _, err := client.FetchRepo(t.Context(), fixtureOwner, fixtureRepo, fixtureOwner+"/"+fixtureRepo)
	require.NoError(t, err)
	byNumber := map[int]dashboard.PullRequest{}
	for _, pr := range prs {
		byNumber[pr.Number] = pr
	}

	nums := make([]int, 0, len(truth))
	for n := range truth {
		nums = append(nums, n)
	}
	sort.Ints(nums)

	var table strings.Builder
	fmt.Fprintf(&table, "\n%-4s %-28s | %-9s %-9s %-5s %-8s | %-10s %-5s %-6s %-5s %-7s | %s\n",
		"#", "scenario", "GH state", "mergeable", "draft", "adminOK", "dash merge", "ci", "behind", "empty", "status", "verdict")
	var disagreements []string
	for _, n := range nums {
		g := truth[n]
		pr, ok := byNumber[n]
		if !ok {
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: GitHub lists it, the dashboard doesn't", n, g.Title))
			continue
		}
		allowed, why := dashboardMergeAllowed(pr)
		want := g.githubMergeable()
		verdict := "agree"
		ticket, known := knownDisagreements[g.Title]
		switch {
		case allowed != want && known:
			verdict = fmt.Sprintf("known, %s (GitHub can merge=%t, dashboard allows=%t)", ticket, want, allowed)
		case allowed == want && known:
			verdict = "agree"
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: now agrees, remove it from knownDisagreements (%s)", n, g.Title, ticket))
		case allowed != want:
			verdict = fmt.Sprintf("DISAGREE (GitHub can merge=%t, dashboard allows=%t: %s)", want, allowed, why)
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: %s", n, g.Title, verdict))
		case pr.Draft != g.IsDraft:
			verdict = fmt.Sprintf("DISAGREE (draft: GitHub %t, dashboard %t)", g.IsDraft, pr.Draft)
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: %s", n, g.Title, verdict))
		}
		fmt.Fprintf(&table, "%-4d %-28s | %-9s %-9s %-5t %-8t | %-10t %-5s %-6t %-5t %-7s | %s\n",
			n, g.Title, g.MergeStateStatus, g.Mergeable, g.IsDraft, g.ViewerCanMergeAdmin,
			allowed, pr.CI, pr.Behind, pr.Empty, pr.MergeStatus, verdict)
	}
	t.Log(table.String())
	require.Empty(t, disagreements, "the dashboard and GitHub disagree:\n%s", strings.Join(disagreements, "\n"))
}
