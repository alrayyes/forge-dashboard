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

func TestMentionedIssueRefs_AClosingKeywordIsNotAMention(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", "Closes #7, #8\nFixes other/repo#9\nRefs #10")

	assert.Equal(t, []int{8, 10}, issueNumbers(got))
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
	for i := 1; i <= 40; i++ {
		fmt.Fprintf(&b, "#%d ", i)
	}
	assert.Len(t, mentioned(dashboard.ForgeForgejo, "", b.String()), 20)
}
