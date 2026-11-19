package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A flip of checksIncomplete with the counts unchanged is something that
// happened, so the poll schedule must not read it as a quiet pull request.
func TestPollFingerprint_ChecksIncompleteChangesIt(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 1}
	incomplete := pr
	incomplete.ChecksIncomplete = true

	assert.NotEqual(t, dashboard.PollFingerprintForTest(pr), dashboard.PollFingerprintForTest(incomplete))
}
