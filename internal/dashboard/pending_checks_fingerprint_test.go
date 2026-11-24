package dashboard_test

import (
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A pull request that gains, loses or swaps the check the forge waits on is
// something that happened, so the poll schedule must not read it as quiet.
func TestPollFingerprint_PendingChecksChangesIt(t *testing.T) {
	t.Parallel()

	pr := dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Repo: "a/b", Number: 1}
	named := pr
	named.PendingChecks = []string{"deploy/gate"}
	swapped := pr
	swapped.PendingChecks = []string{"external/scan"}

	assert.NotEqual(t, dashboard.PollFingerprintForTest(pr), dashboard.PollFingerprintForTest(named))
	assert.NotEqual(t, dashboard.PollFingerprintForTest(named), dashboard.PollFingerprintForTest(swapped))
}
