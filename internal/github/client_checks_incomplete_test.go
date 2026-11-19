package github_test

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// GitHub's rollup reports its checks by state and says nothing about checks
// still to be created, so a pull request never reads as incomplete (#4253): a
// queued check is already in the rollup as QUEUED.
func TestFetch_RollupSaysNothingOfAnIncompleteCheckList(t *testing.T) {
	t.Parallel()

	got := pullRequestFromGraphQLRollup(t, rollupFixture("PENDING", map[string]int{"QUEUED": 3, "IN_PROGRESS": 1}, nil))

	assert.False(t, got.ChecksIncomplete)
}
