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

func TestMentionedIssueRefs_AStrayOpenerInASpaceFreeBodyDoesNotHideLaterSeparators(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	cases := map[string]string{
		"paren":   "#9,(" + strings.Repeat("x", 3000) + ",#8," + strings.Repeat("x", limit) + ",#3",
		"angle":   "#9,<" + strings.Repeat("x", 3000) + ",#8," + strings.Repeat("x", limit) + ",#3",
		"bracket": "#9,[" + strings.Repeat("x", 3000) + ",#8," + strings.Repeat("x", limit) + ",#3",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Equal(t, []int{9, 8}, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
		})
	}
}

func TestMentionedIssueRefs_ADefinitionTitleMayStartOnTheNextLine(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"lf":    "see [#7][1]\n\n[1]: docs/a.md\n  \"Title #8\"\n",
		"crlf":  "see [#7][1]\r\n\r\n[1]: docs/a.md\r\n  \"Title #8\"\r\n",
		"paren": "see [#7][1]\n\n[1]: docs/a.md\n(Title #8)",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			assert.Empty(t, mentioned(dashboard.ForgeForgejo, "", body))
		})
	}
}

func TestMentionedIssueRefs_ATitleThatLooksLikeADefinitionKeepsItsReference(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "[Fix]: #12", "body")

	assert.Equal(t, []int{12}, issueNumbers(got))
}

func TestMentionedIssueRefs_ABodyLineMayStillBeADefinitionAfterSuchATitle(t *testing.T) {
	t.Parallel()

	got := mentioned(dashboard.ForgeForgejo, "[Fix]: #12", "see [#7][1]\n\n[1]: "+mentionBase+"/org/lib/issues/7")

	assert.Equal(t, []int{12, 7}, issueNumbers(got))
}

func TestMentionedIssueRefs_ABracketRunJustUnderTheStrayLimitStillHidesItsSeparators(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	// The semicolon sits this many bytes after the opening "<". A run up to
	// 1 KiB is an address or tag, so the semicolon in it is no place to cut; one
	// byte more is a stray opener and the semicolon is the cut.
	cases := map[string]struct {
		offset int
		want   []int
	}{
		"well under": {900, []int{9}},
		"just under": {1023, []int{9}},
		"at 1 KiB":   {1024, []int{9}},
		"just over":  {1025, []int{9, 55}},
		"well over":  {2000, []int{9, 55}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			// ",#55;" is five bytes, ending on the semicolon.
			body := "#9," + strings.Repeat("x", 100) + "<" + strings.Repeat("x", max(c.offset-5, 0)) +
				",#55;" + strings.Repeat("x", limit)

			assert.Equal(t, c.want, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
		})
	}
}

func TestMentionedIssueRefs_AnOpenAnchorAtTheCutLosesItsTextOnlyWithinOneKiBWhateverItIsWrittenIn(t *testing.T) {
	t.Parallel()

	const limit = 64 << 10
	// The tag's address is multi-byte (a 1000-byte run, so the tag itself is
	// about 1 KiB), and so is the pad before it, which puts the start of the
	// tail window inside a rune. The text is "#7 " and 2-byte runes, textBytes
	// long in all.
	cases := map[string]struct {
		textBytes int
		tagExtra  string
		want      []int
	}{
		"under":      {1023, "", []int{}},
		"at 1 KiB":   {1024, "", []int{}},
		"just over":  {1025, "x", []int{7}},
		"well over":  {2000, "", []int{7}},
		"short text": {100, "x", []int{}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			tag := "<a href=\"" + strings.Repeat("é", 500) + c.tagExtra + "\">"
			rest := c.textBytes - len("#7 ")
			text := "#7 " + strings.Repeat("é", rest/2) + strings.Repeat("x", rest%2)
			// The anchor ends the part that is read, 99 bytes short of the cap, so
			// the tail window starts at an odd byte, inside a 2-byte rune of the pad.
			padBytes := limit - 99 - len(tag) - len(text)
			pad := strings.Repeat("é", padBytes/2) + strings.Repeat("x", padBytes%2)
			body := pad + tag + text + " " + strings.Repeat("z", 400)

			assert.Equal(t, c.want, issueNumbers(mentioned(dashboard.ForgeForgejo, "", body)))
		})
	}
}
