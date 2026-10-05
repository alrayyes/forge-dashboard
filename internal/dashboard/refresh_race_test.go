package dashboard_test

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gatedFullFetchSource answers a full Fetch with what the forge says now, then
// holds the answer until released, the way a slow account-wide fetch does: its
// data is already old by the time it comes back.
type gatedFullFetchSource struct {
	*fakeRepoRefresherSource
	mu      sync.Mutex
	started chan struct{}
	release chan struct{}
}

func (g *gatedFullFetchSource) Fetch(ctx context.Context) dashboard.Result {
	result := g.fakeRepoRefresherSource.Fetch(ctx)

	g.mu.Lock()
	started, release := g.started, g.release
	g.started, g.release = nil, nil
	g.mu.Unlock()
	if started != nil {
		close(started)
		<-release
	}

	return result
}

// A pull request merged while a full refresh is running must stay gone (#966).
// The webhook's scoped refresh sees the merge and removes it; the full
// refresh, which fetched before the merge, must not put it back.
func TestAggregator_AFullRefreshThatStartedBeforeAMergeDoesNotRestoreIt(t *testing.T) {
	t.Parallel()

	src := &gatedFullFetchSource{fakeRepoRefresherSource: newFakeRepoRefresherSource()}
	src.setRepo("alrayyes/a", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 78, Title: "about to merge"}})
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 1)

	// A full refresh starts and reads the forge while #78 is still open.
	src.mu.Lock()
	src.started, src.release = make(chan struct{}), make(chan struct{})
	started, release := src.started, src.release
	src.mu.Unlock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		agg.Refresh(t.Context())
	}()
	<-started

	// It merges, and the webhook's scoped refresh sees that.
	src.setRepo("alrayyes/a", nil)
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))
	require.Empty(t, agg.Get().PullRequests, "the scoped refresh removes the merged pull request")

	// The older full refresh now finishes.
	close(release)
	<-done

	assert.Empty(t, agg.Get().PullRequests, "a refresh that read the forge before the merge must not bring the pull request back")
}

// Scoped refreshes of different repos run side by side. Each reads the
// snapshot, merges its repo in and writes it back, so one must not overwrite
// another's result with a snapshot it read earlier.
func TestAggregator_ConcurrentScopedRefreshesOfDifferentReposKeepEachOther(t *testing.T) {
	t.Parallel()

	const repos = 40
	src := newFakeRepoRefresherSource()
	for i := range repos {
		name := fmt.Sprintf("alrayyes/r%d", i)
		src.setRepo(name, []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: name, Number: i + 1}})
	}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	var wg sync.WaitGroup
	for i := range repos {
		wg.Go(func() {
			agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", fmt.Sprintf("r%d", i), fmt.Sprintf("alrayyes/r%d", i))
		})
	}
	wg.Wait()

	assert.Len(t, agg.Get().PullRequests, repos, "every repo's refresh must survive the others")
}
