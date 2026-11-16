package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestMentionedIssueRefs_GHPrefixFollowsTheCapabilityNotTheForgeName(t *testing.T) {
	// Not parallel: it edits the shared capability table.
	prefixed := Forge("prefixforge")
	plain := Forge("plainforge")
	withForge(t, prefixed, ForgeCapabilities{IssueRefSyntax: IssueRefHashOrGHPref})
	withForge(t, plain, ForgeCapabilities{IssueRefSyntax: IssueRefHash})

	numbers := func(f Forge) []int {
		var out []int
		for _, r := range MentionedIssueRefs(f, "", "see GH-6", "me/app", 99, "https://git.example.com") {
			out = append(out, r.Number)
		}

		return out
	}

	assert.Equal(t, []int{6}, numbers(prefixed))
	assert.Empty(t, numbers(plain))
	assert.Empty(t, numbers(Forge("unknownforge")), "a forge this build doesn't know reads #N only")
}
