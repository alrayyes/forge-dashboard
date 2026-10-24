package dashboard_test

import (
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

const dependabotBody = `Bumps [lib](https://github.com/org/lib) from 1.0 to 2.0.
<details>
<summary>Release notes</summary>
<p><em>Sourced from <a href="https://github.com/org/lib/releases">lib's releases</a>.</em></p>
<blockquote>
<h2>v2.0</h2>
<ul>
<li>Fix crash by <a href="https://github.com/bob"><code>@bob</code></a> in <a href="https://redirect.github.com/org/lib/pull/55">org/lib#55</a></li>
<li>Closes <a href="https://redirect.github.com/org/lib/issues/1234">#1234</a>
<ul>
<li>and <a href="https://redirect.github.com/org/lib/issues/12">#12</a></li>
</ul>
</li>
</ul>
</blockquote>
</details>
<details>
<summary>Commits</summary>
<ul>
<li><a href="https://github.com/org/lib/commit/abc"><code>abc</code></a> Release</li>
</ul>
</details>
<br />

Refs #7`

func TestMentionedIssueRefs_TheTextOfAnHTMLAnchorIsNotAMention(t *testing.T) {
	t.Parallel()

	got := dashboard.MentionedIssueRefs(dashboard.ForgeGitHub, "Bump lib", dependabotBody, "me/repo", 99, "https://github.com")

	assert.Equal(t, []int{7}, issueNumbers(got), "only the line outside the release notes is the author's own")
}

func TestMentionedIssueRefs_AnAnchorToATicketOnTheForgeCountsByItsHref(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "", `<a href="`+mentionBase+`/other/repo/issues/9">#1234</a>`)

	assert.Equal(t, []dashboard.IssueRef{{Repo: "other/repo", Number: 9, URL: mentionBase + "/other/repo/issues/9"}}, got)
}

func TestMentionedIssueRefs_ReferenceStyleAndNestedLinksAreLinks(t *testing.T) {
	t.Parallel()

	body := "Fixed in [#16][1], also [see [#8]](http://x.test/8), [#17][] and [#18].\n\n" +
		"[1]: https://redirect.github.com/org/lib/issues/16\n" +
		"[#17]: https://redirect.github.com/org/lib/issues/17\n" +
		"[#18]: https://redirect.github.com/org/lib/issues/18\n\nRefs #4"

	assert.Equal(t, []int{4}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_AStrayBracketDoesNotBlankLaterLines(t *testing.T) {
	t.Parallel()

	body := "a stray [label]( that never closes\nRefs #12\nand later (a note) <a name=\"x\">anchor\nRefs #13"

	assert.Equal(t, []int{12, 13}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_ReadsOnlyTheFirst64KiBOfTheBody(t *testing.T) {
	t.Parallel()

	filler := strings.Repeat("x", 64<<10)

	assert.Equal(t, []int{1}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", "Refs #1\n"+filler+"\nRefs #2")))
	assert.Equal(t, []int{3}, issueNumbers(mentioned(dashboard.ForgeForgejo, "Refs #3", filler+"\nRefs #4")), "the title is not part of the cap")
}

func TestMentionedIssueRefs_TheCapNeverCutsAReferenceInHalf(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	cases := map[string]string{
		"a bare number":     strings.Repeat("x", limit-4) + " #12345 more",
		"a multi-byte tail": strings.Repeat("é", limit/2-2) + " #12345 more",
		"an address":        strings.Repeat("x", limit-len(mentionBase)-22) + " " + mentionBase + "/other/repo/issues/12345 more",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Empty(t, mentioned(dashboard.ForgeForgejo, "", body))
		})
	}
}

func TestMentionedIssueRefs_AnAnchorMayRunOverLinesAndBeWrittenInCapitals(t *testing.T) {
	t.Parallel()

	body := "<a href=\"https://x.test/1\">\n#41\n</a> and <A HREF=\"https://x.test/2\">#42</A>\nRefs #43"

	assert.Equal(t, []int{43}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_AnUnclosedAnchorDoesNotSwallowWhatFollows(t *testing.T) {
	t.Parallel()

	body := "<a href=\"https://x.test/x\">text\nRefs #11\nRefs #12\n<a href=\"https://x.test/y\">z</a>"

	assert.Equal(t, []int{11, 12}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_ABracketPairWithNoDefinitionIsPlainText(t *testing.T) {
	t.Parallel()

	body := "see [#5][foo] and [#6][] and [#7] here\n\n[#8]: https://x.test/8\n[#9][#8]"

	assert.Equal(t, []int{5, 6, 7}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}
