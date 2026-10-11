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
	"strconv"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	fixtureOwner = "alrayyes"
	fixtureRepo  = "forge-dashboard-e2e-fixture"
)

// difference is a scenario where the dashboard and GitHub deliberately or
// knowingly differ: ticket says which ticket or decision tracks it, and code
// is the reason the dashboard gives for refusing Merge. The test fails on a
// listed scenario that now agrees, so the entry gets removed with the fix
// instead of rotting.
type difference struct {
	ticket string
	code   dashboard.ActionCode
}

// knownDisagreements maps a scenario title to its difference. Every entry is
// by design today; a real bug found here goes in with its ticket number
// until the fix lands.
var knownDisagreements = map[string]difference{
	// GitHub will merge an empty pull request (an empty merge commit); the
	// dashboard refuses on purpose, since there is nothing to merge
	// (dashboard.mergeAvailability's empty case, with its own tests).
	"empty-no-diff": {"by design: the dashboard blocks a merge that would be empty", dashboard.ActionAlreadyUpToDate},
	// GitHub has no notion of a stack. The dashboard blocks the child until
	// its parent merges, since merging it lands it in the parent's branch (#860).
	"stacked-child": {"by design: a stacked pull request waits for its parent (#860)", dashboard.ActionStacked},
}

// bypassTicket is the owner's "merge without waiting for requirements".
// GitHub offers it to a repo admin when enforce_admins is off; the dashboard
// never does, on purpose. Declined, not a bug.
const bypassTicket = "https://github.com/alrayyes/forge-dashboard/issues/958"

// emptyScenario is the fixture pull request built to have no diff at all
// (scripts/e2e-fixture/build.sh).
const emptyScenario = "empty-no-diff"

// githubTruth is what GitHub says about one pull request.
type githubTruth struct {
	Number                   int       `json:"number"`
	Title                    string    `json:"title"`
	State                    string    `json:"state"`
	IsDraft                  bool      `json:"isDraft"`
	Mergeable                string    `json:"mergeable"`
	MergeStateStatus         string    `json:"mergeStateStatus"`
	ReviewDecision           string    `json:"reviewDecision"`
	ViewerCanMergeAdmin      bool      `json:"viewerCanMergeAsAdmin"`
	ViewerCanEnableAutoMerge bool      `json:"viewerCanEnableAutoMerge"`
	AutoMergeRequest         *struct{} `json:"autoMergeRequest"`
	BaseRefName              string    `json:"baseRefName"`
	HeadRefName              string    `json:"headRefName"`
}

func truthQuery(states string) string {
	return `query { repository(owner:"` + fixtureOwner + `", name:"` + fixtureRepo + `") {
  pullRequests(states:` + states + `, first:100, orderBy:{field:CREATED_AT, direction:DESC}) { nodes {
    number title state baseRefName headRefName isDraft mergeable mergeStateStatus reviewDecision viewerCanMergeAsAdmin viewerCanEnableAutoMerge autoMergeRequest{mergeMethod}
  } } } }`
}

func fetchTruth(t *testing.T, states string) map[int]githubTruth {
	t.Helper()
	out, err := exec.Command("gh", "api", "graphql", "-f", "query="+truthQuery(states)).Output()
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

// behindBy is how many commits the base branch has that the head doesn't,
// from GitHub's compare endpoint. mergeStateStatus can't say: BEHIND is
// reported only when nothing else (conflicts, blocks) outranks it.
func (g githubTruth) behindBy(t *testing.T) int {
	t.Helper()
	out, err := exec.Command("gh", "api", fmt.Sprintf("repos/%s/%s/compare/%s...%s", fixtureOwner, fixtureRepo, g.BaseRefName, g.HeadRefName), "--jq", ".behind_by").Output()
	require.NoError(t, err, "gh api compare")
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	require.NoError(t, err)

	return n
}

// githubMergeable is GitHub's own answer to "can the merge button be pressed
// by anyone": the state says so and the PR isn't a draft. The owner's bypass
// is a separate column.
func (g githubTruth) githubMergeable() bool {
	switch g.MergeStateStatus {
	case "CLEAN", "UNSTABLE", "HAS_HOOKS":
		return !g.IsDraft
	}

	return false
}

// bypassOffered is GitHub offering the owner a merge of a pull request that
// requirements block.
func (g githubTruth) bypassOffered() bool {
	return g.ViewerCanMergeAdmin && g.MergeStateStatus == "BLOCKED"
}

func dashboardMerge(pr dashboard.PullRequest) (bool, *dashboard.Blocked) {
	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == dashboard.ActionMerge {
			return a.Blocked == nil, a.Blocked
		}
	}

	return false, &dashboard.Blocked{Message: "no merge action"}
}

func dashboardOffers(pr dashboard.PullRequest, action dashboard.ActionName) bool {
	for _, a := range dashboard.AllowedActions(pr, nil) {
		if a.Action == action {
			return true
		}
	}

	return false
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}

	return "no"
}

func TestGitHubState_DashboardAgreesWithGitHub(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}

	truth := fetchTruth(t, "OPEN")
	require.NotEmpty(t, truth, "fixture has no open pull requests; run scripts/e2e-fixture/build.sh")
	for _, g := range truth {
		require.NotEqual(t, "UNKNOWN", g.MergeStateStatus, "#%d is still being computed by GitHub; rerun in a minute", g.Number)
	}

	client := github.NewClient(token, "", "")
	prs, _, err := client.FetchRepo(t.Context(), fixtureOwner, fixtureRepo, fixtureOwner+"/"+fixtureRepo)
	require.NoError(t, err)
	dashboard.AnnotateStacks(prs)
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
	fmt.Fprintf(&table, "\n%-4s %-28s | %-9s %-11s %-5s %-6s %-8s | %-5s %-12s %-6s %-5s %-6s %-8s | %s\n",
		"#", "scenario", "GH state", "mergeable", "draft", "admin", "autoMrg", "merge", "status", "behind", "empty", "stack", "autoMrg", "verdict")
	var disagreements []string
	for _, n := range nums {
		g := truth[n]
		pr, ok := byNumber[n]
		if !ok {
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: GitHub lists it, the dashboard doesn't", n, g.Title))
			continue
		}
		allowed, blocked := dashboardMerge(pr)
		want := g.githubMergeable()
		var problems []string
		verdict := "agree"
		known, isKnown := knownDisagreements[g.Title]
		switch {
		case allowed != want && isKnown:
			verdict = "known, " + known.ticket
			if blocked == nil || blocked.Code != known.code {
				problems = append(problems, fmt.Sprintf("known difference should be refused with code %q, got %+v", known.code, blocked))
			}
		case allowed == want && isKnown:
			problems = append(problems, fmt.Sprintf("now agrees, remove it from knownDisagreements (%s)", known.ticket))
		case !allowed && !want && g.bypassOffered():
			verdict = "expected, owner bypass: " + bypassTicket
		case allowed != want:
			why := ""
			if blocked != nil {
				why = string(blocked.Code) + ": " + blocked.Message
			}
			problems = append(problems, fmt.Sprintf("Merge (GitHub can merge=%t, dashboard allows=%t: %s)", want, allowed, why))
		}
		if g.Title == emptyScenario && !pr.Empty {
			// The fixture's empty pull request has to be empty to exercise the
			// rule at all (#967); a GitHub-side change that makes it non-empty
			// would otherwise pass here unnoticed.
			problems = append(problems, "the fixture's empty pull request isn't empty")
		}
		if pr.Draft != g.IsDraft {
			problems = append(problems, fmt.Sprintf("draft: GitHub %t, dashboard %t", g.IsDraft, pr.Draft))
		}
		// Behind means the base has commits the head lacks. The dashboard looks
		// past mergeStateStatus for this (#495), so compare with the compare
		// endpoint, not the state. Without strict protection a behind branch is
		// still CLEAN and mergeable.
		if wantBehind := g.behindBy(t) > 0; pr.Behind != wantBehind {
			problems = append(problems, fmt.Sprintf("behind: GitHub compare says %t (state %s), dashboard %t", wantBehind, g.MergeStateStatus, pr.Behind))
		}
		if pr.AutoMergeEnabled == nil || *pr.AutoMergeEnabled != (g.AutoMergeRequest != nil) {
			problems = append(problems, fmt.Sprintf("auto-merge armed: GitHub %t, dashboard %v", g.AutoMergeRequest != nil, pr.AutoMergeEnabled))
		}
		if pr.AutoMergeAllowed == nil || *pr.AutoMergeAllowed != g.ViewerCanEnableAutoMerge {
			problems = append(problems, fmt.Sprintf("auto-merge allowed: GitHub %t, dashboard %v", g.ViewerCanEnableAutoMerge, pr.AutoMergeAllowed))
		}
		if offered := dashboardOffers(pr, dashboard.ActionAutoMerge); offered && (!g.ViewerCanEnableAutoMerge || g.AutoMergeRequest != nil) {
			problems = append(problems, "dashboard offers Enable auto-merge, GitHub would refuse or has it on already")
		}
		if len(problems) > 0 {
			verdict = "DISAGREE (" + strings.Join(problems, "; ") + ")"
			disagreements = append(disagreements, fmt.Sprintf("#%d %s: %s", n, g.Title, verdict))
		}
		stack := "-"
		switch {
		case pr.StackedOn != nil:
			stack = fmt.Sprintf("on #%d", pr.StackedOn.Number)
		case len(pr.StackChildren) > 0:
			stack = "parent"
		}
		fmt.Fprintf(&table, "%-4d %-28s | %-9s %-11s %-5t %-6s %-8s | %-5s %-12s %-6t %-5t %-6s %-8s | %s\n",
			n, g.Title, g.MergeStateStatus, g.Mergeable, g.IsDraft, yesNo(g.ViewerCanMergeAdmin),
			yesNo(g.ViewerCanEnableAutoMerge)+"/"+yesNo(g.AutoMergeRequest != nil),
			yesNo(allowed), pr.MergeStatus, pr.Behind, pr.Empty, stack,
			yesNo(pr.AutoMergeAllowed != nil && *pr.AutoMergeAllowed)+"/"+yesNo(pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled), verdict)
	}
	t.Log(table.String())
	require.Empty(t, disagreements, "the dashboard and GitHub disagree:\n%s", strings.Join(disagreements, "\n"))
}

// A closed or merged pull request is gone from the dashboard: it lists open
// ones only.
func TestGitHubState_ClosedAndMergedPullRequestsAreNotListed(t *testing.T) {
	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		t.Skip("GITHUB_TOKEN not set")
	}

	closed := fetchTruth(t, "[CLOSED, MERGED]")
	require.NotEmpty(t, closed, "fixture has no closed or merged pull requests; run scripts/e2e-fixture/build.sh")
	states := map[string]bool{}
	for _, g := range closed {
		states[g.State] = true
	}
	require.True(t, states["CLOSED"] && states["MERGED"], "the fixture needs one closed and one merged pull request, has %v", states)

	prs, _, err := github.NewClient(token, "", "").FetchRepo(t.Context(), fixtureOwner, fixtureRepo, fixtureOwner+"/"+fixtureRepo)
	require.NoError(t, err)
	listed := map[int]bool{}
	for _, pr := range prs {
		listed[pr.Number] = true
	}
	for n, g := range closed {
		assert.False(t, listed[n], "#%d %s is %s on GitHub but the dashboard lists it", n, g.Title, g.State)
	}
}
