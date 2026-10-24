package dashboard_test

import (
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestMentionedIssueRefs_AnAnchorOpenAtTheCapDoesNotCountItsText(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	open := `<a href="https://x.test/1">`
	body := strings.Repeat("x", limit-len(open)-12) + " " + open + "#55 and more text"

	assert.Empty(t, mentioned(dashboard.ForgeForgejo, "", body))
}

func TestMentionedIssueRefs_TheCapCutsAtAUnicodeSpace(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	body := "Refs #1\u3000" + strings.Repeat("\u3042", limit/3) + "\u3000#2"

	assert.Equal(t, []int{1}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_ABodyWithNoSpaceKeepsWhatPrecedesTheLastWholeToken(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	body := "#1,#2," + strings.Repeat("x", limit) + ",#3"

	assert.Equal(t, []int{1, 2}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_ALabelledLineThatIsNotALinkKeepsItsReferences(t *testing.T) {
	t.Parallel()

	body := "[Context]: relates to #12\n[ctx]: https://x.test/c\n[Note]: see: #13"

	assert.Equal(t, []int{12, 13}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_ADefinitionAtAForgePageStillHidesItsLinks(t *testing.T) {
	t.Parallel()

	body := "see [#7][1]\n\n[1]: " + mentionBase + "/org/lib/issues/7"

	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "org/lib", Number: 7, URL: mentionBase + "/org/lib/issues/7"},
	}, mentioned(dashboard.ForgeForgejo, "", body))
}

func TestMentionedIssueRefs_ADefinitionMayHaveAnyKindOfTarget(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"relative":   "see [#7][1]\n\n[1]: docs/a.md",
		"fragment":   "see [#7][foo]\n\n[foo]: #12",
		"next line":  "see [#7][1]\n\n[1]:\n  docs/a.md",
		"angle":      "see [#7][1]\n\n[1]: <docs/a b.md>",
		"with title": "see [#7][1]\n\n[1]: docs/a.md \"Title #8\"",

		"crlf":            "see [#7][1]\r\n\r\n[1]: docs/a.md\r\n",
		"crlf with title": "see [#7][1]\r\n\r\n[1]: docs/a.md \"Title #8\"\r\n",
		"crlf next line":  "see [#7][1]\r\n\r\n[1]:\r\n  docs/a.md\r\n",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Empty(t, mentioned(dashboard.ForgeForgejo, "", body))
		})
	}
}

func TestMentionedIssueRefs_AnEarlyUnclosedAnchorDoesNotHideLaterReferencesAtTheCap(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	body := "<a href=\"https://x.test/1\">text " + strings.Repeat("x", 4000) + "\nRefs #5\n" +
		strings.Repeat("y ", limit)

	assert.Equal(t, []int{5}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_AClosedAnchorBeforeTheCapKeepsTheReferencesAfterIt(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	body := strings.Repeat("y ", (limit-300)/2) + "<a href=\"https://x.test/1\">#4</a> Refs #5 " +
		strings.Repeat("y ", 500)

	assert.Equal(t, []int{5}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_TheSpaceFreeCutNeverLeavesALinkInHalf(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	link := "[#1234](https://redirect.github.com/org/lib/issues/1234/with/a/long/tail/of/path/segments)"
	body := "#9;" + strings.Repeat("x", limit-30) + ";" + link

	assert.Equal(t, []int{9}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_TheSpaceFreeCutNeverSplitsALinkWhoseAddressHasAComma(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	link := "[#1234](https://redirect.github.com/o/l/issues/1234?a=1,2&b=3)"
	body := "#9," + strings.Repeat("x", limit-60) + link

	assert.Equal(t, []int{9}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
}

func TestMentionedIssueRefs_TheSpaceFreeCutSkipsSeparatorsInsideBrackets(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	cases := map[string]struct {
		body string
		want []int
	}{
		"an open tag":       {"#9," + strings.Repeat("x", limit-30) + "<;#55;" + strings.Repeat("x", 40) + ">", []int{9}},
		"a closed tag":      {"#9,<t>,#8," + strings.Repeat("x", limit) + ",#3", []int{9, 8}},
		"a stray closer":    {"#9),#8," + strings.Repeat("x", limit) + ",#3", []int{9, 8}},
		"a closed bracket":  {"#9,[a],#8," + strings.Repeat("x", limit) + ",#3", []int{9, 8}},
		"a closed paren":    {"#9,(a),#8," + strings.Repeat("x", limit) + ",#3", []int{9, 8}},
		"a semicolon alone": {"#9;#8;" + strings.Repeat("x", limit) + ";#3", []int{9, 8}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, c.want, issueNumbers(mentioned(dashboard.ForgeForgejo, "", c.body)))
		})
	}
}

func TestMentionedIssueRefs_ANonBreakingSpaceSeparatesAReference(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []int{5}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", "Refs\u00a0#5")))
}
