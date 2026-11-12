package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func referenced(forge dashboard.Forge, title, body string) []dashboard.IssueRef {
	return dashboard.ReferencedIssueRefs(forge, title, body, "alrayyes/app", 99, mentionBase)
}

func TestReferencedIssueRefs_ReadsTheReferenceKeywords(t *testing.T) {
	t.Parallel()

	for _, text := range []string{"Refs #12", "Ref #12", "refs: #12", "Related to #12", "related to: #12", "See #12", "see #12.", "(Refs #12)"} {
		got := referenced(dashboard.ForgeGitHub, "", text)
		assert.Equal(t, []int{12}, issueNumbers(got), text)
	}
}

func TestReferencedIssueRefs_ABareMentionIsNotAReference(t *testing.T) {
	t.Parallel()

	got := referenced(dashboard.ForgeGitHub, "Work on #1", "Closes #2\nSeen in #3\nprefs #4\nsee\n#5\nSee the #6 thread")

	assert.Empty(t, got)
}

func TestReferencedIssueRefs_NamesTheRepoOfACrossRepoReference(t *testing.T) {
	t.Parallel()

	got := referenced(dashboard.ForgeForgejo, "", "Refs Other/Repo#3 and see https://git.example.com/third/repo/issues/4")

	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "other/repo", Number: 3, URL: mentionBase + "/other/repo/issues/3"},
		{Repo: "third/repo", Number: 4, URL: mentionBase + "/third/repo/issues/4"},
	}, got)
}

func TestReferencedIssueRefs_ReadsAListAfterOneKeyword(t *testing.T) {
	t.Parallel()

	got := referenced(dashboard.ForgeGitHub, "", "Refs #3, #4 and #5\nRefs #3")

	assert.Equal(t, []int{3, 4, 5}, issueNumbers(got), "in order, without repeats")
}

func TestReferencedIssueRefs_CodeAndCommentsAreIgnored(t *testing.T) {
	t.Parallel()

	body := "```\nRefs #7\n```\n`Refs #8`\n<!-- Refs #9 -->\nRefs #10"

	assert.Equal(t, []int{10}, issueNumbers(referenced(dashboard.ForgeGitHub, "", body)))
}

func TestReferencedIssueRefs_NotThePullRequestItself(t *testing.T) {
	t.Parallel()

	assert.Empty(t, referenced(dashboard.ForgeGitHub, "", "Refs #99"))
}

func TestReferencedIssueRefs_LinkTextIsNotAReference(t *testing.T) {
	t.Parallel()

	assert.Empty(t, referenced(dashboard.ForgeGitHub, "", "See [#12](https://redirect.github.com/org/lib/issues/12)"))
}

func TestReferencedIssueRefs_TheTitleCounts(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []int{5}, issueNumbers(referenced(dashboard.ForgeGitHub, "Part 2 (refs #5)", "")))
}

func TestPullRequest_RefsOnlyLeavesOutWhatItCloses(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Forge:        dashboard.ForgeGitHub,
		ClosesIssues: []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12}},
		RefsIssues: []dashboard.IssueRef{
			{Repo: "Alrayyes/App", Number: 12}, {Repo: "alrayyes/app", Number: 13},
		},
	}

	assert.Equal(t, []int{13}, issueNumbers(pr.RefsOnly()))
	assert.NotNil(t, dashboard.PullRequest{}.RefsOnly(), "never nil")
}

func TestPullRequestsReferencing_IndexesByIssueAndSkipsWhatIsClosed(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 1,
		ClosesIssues: []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12}},
		RefsIssues:   []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12}, {Repo: "alrayyes/app", Number: 13}},
	}
	index := dashboard.PullRequestsReferencing([]dashboard.PullRequest{pr})

	assert.Empty(t, index.For(dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 12}))
	assert.Len(t, index.For(dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 13}), 1)
}

func TestPullRequest_MentionedPlainlyLeavesOutRefsToo(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Forge:          dashboard.ForgeGitHub,
		MentionsIssues: []dashboard.IssueRef{{Repo: "a/b", Number: 1}, {Repo: "a/b", Number: 2}, {Repo: "a/b", Number: 3}},
		ClosesIssues:   []dashboard.IssueRef{{Repo: "a/b", Number: 1}},
		RefsIssues:     []dashboard.IssueRef{{Repo: "A/B", Number: 2}},
	}

	assert.Equal(t, []int{3}, issueNumbers(pr.MentionedPlainly()))
}

func TestPullRequestsMentioning_LeavesOutWhatThePullRequestReferences(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{
		Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 1,
		MentionsIssues: []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12}, {Repo: "alrayyes/app", Number: 13}},
		RefsIssues:     []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12}},
	}
	index := dashboard.PullRequestsMentioning([]dashboard.PullRequest{pr})

	assert.Empty(t, index.For(dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 12}))
	assert.Len(t, index.For(dashboard.Issue{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/app", Number: 13}), 1)
}
