package github_test

import (
	"regexp"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
)

// A repo fetched by name (the changed-repo path) must map to the same pull
// request as one read by the account-wide listing, so every selection asks
// for the conversation comment count.
func TestPullRequestSelections_AllAskForTheConversationCommentCount(t *testing.T) {
	t.Parallel()

	// A pull request's own comments sit right before reviewThreads; the
	// thread comments inside it are a different count.
	prComments := regexp.MustCompile(`(?s)comments\s*\{\s*totalCount\s*\}\s*reviewThreads`)
	for name, selection := range github.PullRequestSelections() {
		assert.Regexp(t, prComments, selection, name)
	}
}
