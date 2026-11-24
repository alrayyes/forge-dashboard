package api

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A row that starts or stops naming the check the forge waits on, with equal
// counts, is a change the stream has to send again.
func TestRowSignature_PendingChecksChangesIt(t *testing.T) {
	t.Parallel()

	row := func(names ...string) dashboard.Snapshot {
		return dashboard.Snapshot{PullRequests: []dashboard.PullRequest{{
			Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 1, PendingChecks: names,
		}}}
	}

	none, found := PullRequestRowSignatureForTest(row(), "forgejo", "a/b", 1)
	one, _ := PullRequestRowSignatureForTest(row("deploy/gate"), "forgejo", "a/b", 1)
	other, _ := PullRequestRowSignatureForTest(row("external/scan"), "forgejo", "a/b", 1)

	assert.True(t, found)
	assert.NotEqual(t, none, one)
	assert.NotEqual(t, one, other)
}
