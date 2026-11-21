package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A mention may name a pull request, whose title the board holds too (#4326).
func TestResolveTitles_AMentionedPullRequestGetsItsTitle(t *testing.T) {
	t.Parallel()

	mention := func(repo string, number int) mentionedIssue {
		var m mentionedIssue
		m.Repo, m.Number = repo, number

		return m
	}
	var pr pullRequestView
	pr.Forge, pr.Repo, pr.Number = dashboard.ForgeGitHub, "o/a", 1
	pr.MentionsIssues = []mentionedIssue{mention("O/A", 2), mention("o/a", 3)}
	prs := []pullRequestView{pr}
	held := []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "o/a", Number: 2, Title: "Add the thing"}}

	resolveTitles(prs, nil, held)

	assert.Equal(t, "Add the thing", prs[0].MentionsIssues[0].Title)
	assert.Empty(t, prs[0].MentionsIssues[1].Title)
}
