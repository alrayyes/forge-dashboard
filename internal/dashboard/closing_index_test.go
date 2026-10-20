package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func numbersOf(prs []dashboard.PullRequest) []int {
	out := make([]int, 0, len(prs))
	for _, pr := range prs {
		out = append(out, pr.Number)
	}

	return out
}

// The reverse of ClosesIssues: which pull requests will close a given issue.
// GitHub reports the issue's repo as it is spelled, Forgejo's keyword parse
// lowercases it, and the issue itself keeps the repo's own spelling, so the
// lookup ignores case. It never crosses forges: a number is only an issue on
// the forge that holds it.
func TestPullRequestsClosing_FindsThePullRequestsThatCloseAnIssue(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		forge dashboard.Forge
		repo  string
		prs   []dashboard.PullRequest
		issue dashboard.Issue
		want  []int
	}{
		{
			name: "github, same repo", forge: dashboard.ForgeGitHub,
			prs: []dashboard.PullRequest{
				{Forge: dashboard.ForgeGitHub, Repo: "Alrayyes/Hush", Number: 4, ClosesIssues: []dashboard.IssueRef{{Repo: "Alrayyes/Hush", Number: 2}}},
			},
			issue: dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "Alrayyes/Hush", Number: 2},
			want:  []int{4},
		},
		{
			name: "forgejo, lowercased reference against a mixed-case repo", forge: dashboard.ForgeForgejo,
			prs: []dashboard.PullRequest{
				{Forge: dashboard.ForgeForgejo, Repo: "Ryan/Hush", Number: 9, ClosesIssues: []dashboard.IssueRef{{Repo: "ryan/hush", Number: 3}}},
			},
			issue: dashboard.Issue{Forge: dashboard.ForgeForgejo, Repo: "Ryan/Hush", Number: 3},
			want:  []int{9},
		},
		{
			name: "forgejo, a pull request in another repo closes it with owner/repo#N", forge: dashboard.ForgeForgejo,
			prs: []dashboard.PullRequest{
				{Forge: dashboard.ForgeForgejo, Repo: "ryan/b", Number: 1, ClosesIssues: []dashboard.IssueRef{{Repo: "ryan/a", Number: 3}}},
			},
			issue: dashboard.Issue{Forge: dashboard.ForgeForgejo, Repo: "ryan/a", Number: 3},
			want:  []int{1},
		},
		{
			name: "several pull requests come back by number", forge: dashboard.ForgeGitHub,
			prs: []dashboard.PullRequest{
				{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 30, ClosesIssues: []dashboard.IssueRef{{Repo: "o/a", Number: 1}}},
				{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 12, ClosesIssues: []dashboard.IssueRef{{Repo: "o/a", Number: 1}, {Repo: "o/a", Number: 2}}},
			},
			issue: dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 1},
			want:  []int{12, 30},
		},
		{
			name: "the same number on the other forge is another issue", forge: dashboard.ForgeGitHub,
			prs: []dashboard.PullRequest{
				{Forge: dashboard.ForgeForgejo, Repo: "o/a", Number: 5, ClosesIssues: []dashboard.IssueRef{{Repo: "o/a", Number: 1}}},
			},
			issue: dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 1},
			want:  []int{},
		},
		{
			name: "a pull request that closes nothing is not listed", forge: dashboard.ForgeGitHub,
			prs:   []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 5}},
			issue: dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 1},
			want:  []int{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			index := dashboard.PullRequestsClosing(tt.prs)

			assert.Equal(t, tt.want, numbersOf(index.For(tt.issue)))
		})
	}
}
