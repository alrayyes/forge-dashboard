package dashboard

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// A rebase already sent to a Dependabot pull request is not sent again, but an
// edited branch gets a branch update instead, so the prediction has to follow
// the timed retry that update uses and not the one-shot rebase record (#4023).
func TestUpdateWouldBeTried_EditedDependabotPRIgnoresTheRebaseRecord(t *testing.T) {
	t.Parallel()

	agg := NewAggregator(nil)
	agg.EnableAutoUpdateBranch(nil)
	pr := PullRequest{Forge: ForgeGitHub, Repo: "alrayyes/a", Number: 1, Author: "dependabot", Behind: true}
	agg.autoUpdate.dependabotAttempted[dependabotPRKey(pr)] = struct{}{}

	assert.False(t, agg.updateWouldBeTried(pr), "a plain Dependabot PR was already sent its one rebase")

	pr.EditedByOthers = true
	assert.True(t, agg.updateWouldBeTried(pr), "an edited one is updated, not left alone")
}

// A rebase queued before the branch was edited is skipped at run time rather
// than posting the command Dependabot refuses.
func TestQueuedSkipReason_RebaseOnEditedDependabotPRNoLongerApplies(t *testing.T) {
	t.Parallel()

	pr := PullRequest{Forge: ForgeGitHub, Repo: "alrayyes/a", Number: 1, Author: "dependabot", Behind: true, EditedByOthers: true}
	code, _ := queuedSkipReason(QueuedAction{Action: ActionDependabotRebase}, pr, nil)

	assert.Equal(t, ActionNotMergeable, code)
}
