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
	body := "Refs #1　" + strings.Repeat("あ", limit/3) + "　#2"

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
