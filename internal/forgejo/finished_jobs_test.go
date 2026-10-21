package forgejo

import (
	"fmt"
	"testing"

	"code.gitea.io/sdk/gitea"
	"github.com/stretchr/testify/assert"
)

func someJobs() []*gitea.ActionWorkflowJob {
	return []*gitea.ActionWorkflowJob{{Status: "success"}}
}

// Past its cap the cache lets the oldest entries go one at a time, so the runs
// polled most recently stay kept instead of the whole cache starting over.
func TestFinishedJobs_PastTheCapTheOldestEntriesGoFirst(t *testing.T) {
	t.Parallel()

	cache := newFinishedJobs(maxFinishedJobs)
	for i := range maxFinishedJobs + 3 {
		cache.put(fmt.Sprintf("run-%d", i), someJobs())
	}

	for i := range 3 {
		_, ok := cache.get(fmt.Sprintf("run-%d", i))
		assert.False(t, ok, "run-%d is among the three oldest", i)
	}
	for i := 3; i < maxFinishedJobs+3; i++ {
		_, ok := cache.get(fmt.Sprintf("run-%d", i))
		assert.True(t, ok, "run-%d is kept", i)
	}
}

func TestFinishedJobs_PuttingAKeyAgainDoesNotAgeOutAnotherEntry(t *testing.T) {
	t.Parallel()

	cache := newFinishedJobs(2)
	cache.put("a", someJobs())
	cache.put("b", someJobs())
	cache.put("b", someJobs())

	_, hasA := cache.get("a")
	_, hasB := cache.get("b")
	assert.True(t, hasA)
	assert.True(t, hasB)
}
