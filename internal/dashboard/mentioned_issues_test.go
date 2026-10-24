package dashboard_test

import (
	"fmt"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

const mentionBase = "https://git.example.com"

func mentioned(forge dashboard.Forge, title, body string) []dashboard.IssueRef {
	return dashboard.MentionedIssueRefs(forge, title, body, "alrayyes/app", 99, mentionBase)
}

func TestMentionedIssueRefs_ReadsHashNumberOwnerRepoAndURLs(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "Work on #1",
		"Refs #2, see Other/Repo#3 and https://git.example.com/third/repo/issues/4 or ("+mentionBase+"/alrayyes/app/pulls/5).")

	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "alrayyes/app", Number: 1, URL: mentionBase + "/alrayyes/app/issues/1"},
		{Repo: "alrayyes/app", Number: 2, URL: mentionBase + "/alrayyes/app/issues/2"},
		{Repo: "other/repo", Number: 3, URL: mentionBase + "/other/repo/issues/3"},
		{Repo: "third/repo", Number: 4, URL: mentionBase + "/third/repo/issues/4"},
		{Repo: "alrayyes/app", Number: 5, URL: mentionBase + "/alrayyes/app/issues/5"},
	}, got)
}

func TestMentionedIssueRefs_ClosingTextIsReadAsMentionsAndSubtractedLater(t *testing.T) {
	t.Parallel()

	// Whether "Closes #7" closes depends on the branch the pull request aims
	// at, which the parser can't see; MentionedOnly takes the closed ones off.
	got := mentioned(dashboard.ForgeForgejo, "Fixes #3", "Closes #7, #8\nFixes other/repo#9\nRefs #10")

	assert.Equal(t, []int{3, 7, 8, 9, 10}, issueNumbers(got))
}

func TestMentionedIssueRefs_ALinkTextIsNotAMention(t *testing.T) {
	t.Parallel()

	body := "This PR contains the following updates:\n\n" +
		"| Package | Change |\n|---|---|\n| [lib](https://redirect.github.com/org/lib) | `1.0` -> `1.1` |\n\n" +
		"### Release Notes\n\n* fix crash ([#1234](https://redirect.github.com/org/lib/issues/1234))\n" +
		"* [#71](http://x.test/71) and [org/lib#72](https://github.com/org/lib/pull/72)\n" +
		"Fixes [#73](https://github.com/org/lib/issues/73)\n\nSee #5"

	assert.Equal(t, []int{5}, issueNumbers(mentioned(dashboard.ForgeForgejo, "Update lib", body)))
}

func TestMentionedIssueRefs_ALinkToATicketOnTheForgeCountsByItsTarget(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", "see [the ticket]("+mentionBase+"/other/repo/issues/12) and [#99]("+mentionBase+"/other/repo/pulls/13)")

	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "other/repo", Number: 12, URL: mentionBase + "/other/repo/issues/12"},
		{Repo: "other/repo", Number: 13, URL: mentionBase + "/other/repo/issues/13"},
	}, got)
}

func TestMentionedIssueRefs_EmphasisAndTableCellsDoNotHideAReference(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", "**#5** _#6_ *#7* ~~#8~~ |#9| |a|#10|\n_#11")

	assert.Equal(t, []int{5, 6, 7, 8, 9, 10, 11}, issueNumbers(got))
}

func TestMentionedIssueRefs_IgnoresCodeAndHTMLComments(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", "`#1` ```\n#2\n```\n<!-- #3 -->\n#4")

	assert.Equal(t, []int{4}, issueNumbers(got))
}

func TestMentionedIssueRefs_TheReferenceHasToStandAlone(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", "abc#1 #2abc &#3 color #4ff #5 https://x.test/page#6 #7")

	assert.Equal(t, []int{5, 7}, issueNumbers(got))
}

func TestMentionedIssueRefs_ARepeatIsListedOnceAndThePullRequestItselfNever(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "#99 and #3", "#3 again, alrayyes/app#3, ALRAYYES/APP#4, and #99")

	assert.Equal(t, []int{3, 4}, issueNumbers(got))
}

func TestMentionedIssueRefs_GHDashNumberIsGitHubOnly(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []int{6}, issueNumbers(mentioned(dashboard.ForgeGitHub, "", "see GH-6")))
	assert.Empty(t, mentioned(dashboard.ForgeForgejo, "", "see GH-6"))
}

func TestMentionedIssueRefs_AQuotedReferenceStillCounts(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []int{8}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", "> as said in #8")))
}

func TestMentionedIssueRefs_IsNeverNilAndCapped(t *testing.T) {
	t.Parallel()

	assert.NotNil(t, mentioned(dashboard.ForgeForgejo, "", ""))
	var b strings.Builder
	for i := 1; i <= 150; i++ {
		fmt.Fprintf(&b, "#%d ", i)
	}
	assert.Len(t, mentioned(dashboard.ForgeForgejo, "", b.String()), 100, "a bound on work; the lists show 20 once closed ones are off")
}

func TestPullRequest_MentionedOnlyDropsWhatItClosesBeforeCapping(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo}
	for i := 1; i <= 25; i++ {
		ref := dashboard.IssueRef{Repo: "a/b", Number: i}
		pr.MentionsIssues = append(pr.MentionsIssues, ref)
		if i <= 3 {
			pr.ClosesIssues = append(pr.ClosesIssues, dashboard.IssueRef{Repo: "A/B", Number: i})
		}
	}

	got := pr.MentionedOnly()

	assert.Len(t, got, 20)
	assert.Equal(t, 4, got[0].Number, "the closed ones are gone, so the cap leaves room for later ones")
}

func TestPullRequest_MentionedOnlyIsNeverNil(t *testing.T) {
	t.Parallel()

	assert.NotNil(t, dashboard.PullRequest{}.MentionedOnly())
}

func TestPullRequestsMentioning_IndexesByIssueWithoutWhatThePullRequestCloses(t *testing.T) {
	t.Parallel()

	one := dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 2,
		ClosesIssues:   []dashboard.IssueRef{{Repo: "a/b", Number: 5}},
		MentionsIssues: []dashboard.IssueRef{{Repo: "a/b", Number: 5}, {Repo: "a/b", Number: 6}},
	}
	two := dashboard.PullRequest{
		Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 1,
		MentionsIssues: []dashboard.IssueRef{{Repo: "A/B", Number: 6}, {Repo: "a/b", Number: 6}},
	}

	index := dashboard.PullRequestsMentioning([]dashboard.PullRequest{one, two})

	issue := func(n int) dashboard.Issue {
		return dashboard.Issue{Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: n}
	}
	assert.Empty(t, index.For(issue(5)), "closed by the only pull request that names it")
	got := index.For(issue(6))
	if assert.Len(t, got, 2, "once per pull request, ordered by number") {
		assert.Equal(t, []int{1, 2}, []int{got[0].Number, got[1].Number})
	}
}

func TestIssuePageURL_OpensTheIssueOnTheDashboard(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "/issues.html?issue=forgejo/a/b/7", dashboard.IssuePageURL(dashboard.ForgeForgejo, "a/b", 7))
}
