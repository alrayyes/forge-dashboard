package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func closingClient() *fakeForgeClient {
	closes := []dashboard.IssueRef{{Repo: "o/a", Number: 12, URL: "https://forge/o/a/issues/12"}}

	return &fakeForgeClient{
		repos: []dashboard.RepoRef{{FullName: "o/a", Owner: "o", Name: "a", DefaultBranch: "main"}},
		prsByRepo: map[string][]dashboard.PullRequest{"o/a": {
			{Number: 1, BaseBranch: "main", ClosesIssues: closes},
			{Number: 2, BaseBranch: "release/1", ClosesIssues: closes},
		}},
	}
}

// A closing keyword only acts when the pull request merges into the repo's
// default branch (GitHub and Forgejo both), so a pull request aimed anywhere
// else closes nothing and lists no issue.
func TestGenericSource_Fetch_APullRequestNotAimedAtTheDefaultBranchClosesNothing(t *testing.T) {
	t.Parallel()

	res := dashboard.NewGenericSource(dashboard.ForgeGitHub, closingClient(), 2).Fetch(t.Context())

	require.Len(t, res.PullRequests, 2)
	byNumber := map[int]dashboard.PullRequest{}
	for _, pr := range res.PullRequests {
		byNumber[pr.Number] = pr
	}
	assert.Len(t, byNumber[1].ClosesIssues, 1, "aimed at main")
	assert.Equal(t, []dashboard.IssueRef{}, byNumber[2].ClosesIssues, "aimed at release/1: never null, and empty")
}

func TestGenericSource_FetchRepo_ASingleRepoRefreshAppliesTheSameRule(t *testing.T) {
	t.Parallel()

	src := dashboard.NewGenericSource(dashboard.ForgeGitHub, closingClient(), 2)
	src.Fetch(t.Context())

	prs, _, err := src.FetchRepo(t.Context(), "o", "a", "o/a")

	require.NoError(t, err)
	byNumber := map[int]dashboard.PullRequest{}
	for _, pr := range prs {
		byNumber[pr.Number] = pr
	}
	assert.Len(t, byNumber[1].ClosesIssues, 1)
	assert.Empty(t, byNumber[2].ClosesIssues)
}

func TestGenericSource_Fetch_ARepoWithNoKnownDefaultBranchKeepsWhatTheForgeSaid(t *testing.T) {
	t.Parallel()

	client := closingClient()
	client.repos[0].DefaultBranch = ""

	res := dashboard.NewGenericSource(dashboard.ForgeGitHub, client, 2).Fetch(t.Context())

	for _, pr := range res.PullRequests {
		assert.Len(t, pr.ClosesIssues, 1, "no default branch to compare with, so nothing is dropped")
	}
}
