package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// The stream lists a row's jobs again when its signature changes, and a flip of
// checksIncomplete with equal counts is such a change.
func TestRowSignature_ChecksIncompleteChangesIt(t *testing.T) {
	t.Parallel()

	row := func(incomplete bool) dashboard.Snapshot {
		return dashboard.Snapshot{PullRequests: []dashboard.PullRequest{{
			Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 1, ChecksIncomplete: incomplete,
		}}}
	}

	before, found := PullRequestRowSignatureForTest(row(false), "forgejo", "a/b", 1)
	after, _ := PullRequestRowSignatureForTest(row(true), "forgejo", "a/b", 1)

	assert.True(t, found)
	assert.NotEqual(t, before, after)
}
