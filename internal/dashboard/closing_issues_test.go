package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

const closingBase = "https://git.example.com"

func TestClosingIssueRefs_ReadsTheKeywordsForgejoActsOn(t *testing.T) {
	t.Parallel()

	for _, kw := range []string{"close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved", "Closes", "FIXES"} {
		got := dashboard.ClosingIssueRefs(kw+" #12", "alrayyes/app", closingBase)

		assert.Equal(t, []dashboard.IssueRef{{Repo: "alrayyes/app", Number: 12, URL: "https://git.example.com/alrayyes/app/issues/12"}}, got, kw)
	}
}

func TestClosingIssueRefs_AColonAfterTheKeywordIsAccepted(t *testing.T) {
	t.Parallel()

	got := dashboard.ClosingIssueRefs("Closes: #7", "alrayyes/app", closingBase)

	assert.Equal(t, []int{7}, issueNumbers(got))
}

func TestClosingIssueRefs_AKeywordAppliesToTheReferenceRightAfterIt(t *testing.T) {
	t.Parallel()

	got := dashboard.ClosingIssueRefs("Closes #1, #2 and fixes #3", "alrayyes/app", closingBase)

	assert.Equal(t, []int{1, 3}, issueNumbers(got), "#2 has no keyword of its own")
}

func TestClosingIssueRefs_OtherRepoReferenceKeepsItsOwnRepoAndURL(t *testing.T) {
	t.Parallel()

	got := dashboard.ClosingIssueRefs("Fixes alrayyes/other#5", "alrayyes/app", closingBase)

	assert.Equal(t, []dashboard.IssueRef{{Repo: "alrayyes/other", Number: 5, URL: "https://git.example.com/alrayyes/other/issues/5"}}, got)
}

func TestClosingIssueRefs_IgnoresWhatForgejoDoesNotActOn(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"a pull request reference": "closes !4",
		"no keyword":               "see #4",
		"reopen keyword":           "reopens #4",
		"a comma after keyword":    "closes, #4",
		"part of a word":           "encloses #4",
		"no space":                 "closes#4",
		"empty body":               "",
	} {
		assert.Empty(t, dashboard.ClosingIssueRefs(body, "alrayyes/app", closingBase), name)
	}
}

func TestClosingIssueRefs_ARepeatedReferenceIsListedOnceInOrderOfAppearance(t *testing.T) {
	t.Parallel()

	got := dashboard.ClosingIssueRefs("Closes #9\n\nfixes #3\n\nResolves #9", "alrayyes/app", closingBase)

	assert.Equal(t, []int{9, 3}, issueNumbers(got))
}

func TestClosingIssueRefs_AKeywordAfterAnOpeningBracketCounts(t *testing.T) {
	t.Parallel()

	assert.Equal(t, []int{8}, issueNumbers(dashboard.ClosingIssueRefs("done (closes #8)", "alrayyes/app", closingBase)))
}

// Forgejo reads the rendered text, so a keyword in a code block or an HTML
// comment (a template's placeholder, say) closes nothing.
func TestClosingIssueRefs_IgnoresCodeAndHTMLComments(t *testing.T) {
	t.Parallel()

	for name, body := range map[string]string{
		"a backtick fence":    "```\ncloses #4\n```",
		"a tilde fence":       "~~~\nFixes #4\n~~~",
		"an inline span":      "run `closes #4` to see",
		"an HTML comment":     "<!-- closes #4 -->",
		"a multiline comment": "<!--\nCloses #4\n-->",
	} {
		assert.Empty(t, dashboard.ClosingIssueRefs(body, "alrayyes/app", closingBase), name)
	}
}

func TestClosingIssueRefs_AKeywordOutsideTheCodeStillCounts(t *testing.T) {
	t.Parallel()

	body := "```\ncloses #4\n```\n\nCloses #5 <!-- closes #6 -->"

	assert.Equal(t, []int{5}, issueNumbers(dashboard.ClosingIssueRefs(body, "alrayyes/app", closingBase)))
}

func TestClosingIssueRefs_TheNumberHasToEndThere(t *testing.T) {
	t.Parallel()

	for _, body := range []string{"closes #4abc", "closes #4_x", "closes owner/repo#4abc"} {
		assert.Empty(t, dashboard.ClosingIssueRefs(body, "alrayyes/app", closingBase), body)
	}
	assert.Equal(t, []int{4}, issueNumbers(dashboard.ClosingIssueRefs("closes #4.", "alrayyes/app", closingBase)), "a full stop ends it")
	assert.Equal(t, []int{4}, issueNumbers(dashboard.ClosingIssueRefs("closes #4", "alrayyes/app", closingBase)), "the end of the text does too")
}

// Forgejo matches repository names without regard to case, so Alrayyes/Other#5
// and alrayyes/other#5 are one reference.
func TestClosingIssueRefs_AnotherRepoIsLowercased(t *testing.T) {
	t.Parallel()

	got := dashboard.ClosingIssueRefs("Fixes AlRayyes/Other#5 and fixes alrayyes/other#5", "alrayyes/app", closingBase)

	assert.Equal(t, []dashboard.IssueRef{{Repo: "alrayyes/other", Number: 5, URL: "https://git.example.com/alrayyes/other/issues/5"}}, got)
}

func TestClosingIssueRefs_IsNeverNil(t *testing.T) {
	t.Parallel()

	assert.NotNil(t, dashboard.ClosingIssueRefs("nothing here", "alrayyes/app", closingBase))
}

func issueNumbers(refs []dashboard.IssueRef) []int {
	out := make([]int, 0, len(refs))
	for _, r := range refs {
		out = append(out, r.Number)
	}

	return out
}
