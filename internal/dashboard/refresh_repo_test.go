package dashboard_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fakeRepoRefresherSource implements both dashboard.Source and
// dashboard.RepoRefresher. Fetch answers with the union of every repo's
// current pull requests/issues (as a real GenericSource-backed forge
// would on a full account refresh); FetchRepo answers with just one
// repo's, and records how many times each repo was asked for — the
// assertion surface for "only the named repo was refetched."
type fakeRepoRefresherSource struct {
	forge dashboard.Forge
	// delay simulates the real network round trip a scoped refresh
	// would make. Without it, FetchRepo returns before a concurrent
	// caller's own call even reaches the coalescer's lock, so a test
	// asserting concurrent triggers actually overlap needs this to
	// reproduce real contention rather than five back-to-back calls
	// that each individually find no run already in flight.
	delay time.Duration

	mu             sync.Mutex
	byRepo         map[string][]dashboard.PullRequest
	issues         map[string][]dashboard.Issue
	fetchCalls     int
	repoFetchCalls map[string]int
}

func newFakeRepoRefresherSource(forge dashboard.Forge) *fakeRepoRefresherSource {
	return &fakeRepoRefresherSource{
		forge:          forge,
		byRepo:         make(map[string][]dashboard.PullRequest),
		issues:         make(map[string][]dashboard.Issue),
		repoFetchCalls: make(map[string]int),
	}
}

func (f *fakeRepoRefresherSource) Forge() dashboard.Forge { return f.forge }

func (f *fakeRepoRefresherSource) setRepo(fullName string, prs []dashboard.PullRequest, issues []dashboard.Issue) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byRepo[fullName] = prs
	f.issues[fullName] = issues
}

func (f *fakeRepoRefresherSource) Fetch(_ context.Context) dashboard.Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fetchCalls++

	result := dashboard.Result{Health: dashboard.ForgeHealth{Forge: f.forge, Reachable: true, RepoCount: len(f.byRepo)}}
	for _, prs := range f.byRepo {
		result.PullRequests = append(result.PullRequests, prs...)
	}
	for _, issues := range f.issues {
		result.Issues = append(result.Issues, issues...)
	}
	return result
}

func (f *fakeRepoRefresherSource) FetchRepo(_ context.Context, _, _, fullName string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	time.Sleep(f.delay)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.repoFetchCalls[fullName]++
	return f.byRepo[fullName], f.issues[fullName], nil
}

func (f *fakeRepoRefresherSource) fetchCallCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fetchCalls
}

func (f *fakeRepoRefresherSource) repoFetchCallCount(fullName string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.repoFetchCalls[fullName]
}

func TestAggregator_RefreshRepo_OnlyRefetchesAndReplacesTheNamedRepo(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource(dashboard.ForgeGitHub)
	src.setRepo("alrayyes/a", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "old a"}}, nil)
	src.setRepo("alrayyes/b", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/b", Number: 2, Title: "b"}}, nil)

	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())
	require.Len(t, agg.Get().PullRequests, 2, "full refresh should have picked up both repos")

	// The webhook that would trigger this named repo A specifically, with
	// updated data — as if a new PR had just been opened on GitHub.
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Title: "old a"},
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 3, Title: "new a"},
	}, nil)

	ok := agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	require.True(t, ok)
	assert.Equal(t, 1, src.fetchCallCount(), "a scoped refresh must not fall back to a full account-wide Fetch")
	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"))
	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/b"), "only the named repo should be refetched")

	snap := agg.Get()
	require.Len(t, snap.PullRequests, 3, "repo b's untouched PR plus repo a's two current ones")
	var repoATitles, repoBTitles []string
	for _, pr := range snap.PullRequests {
		switch pr.Repo {
		case "alrayyes/a":
			repoATitles = append(repoATitles, pr.Title)
		case "alrayyes/b":
			repoBTitles = append(repoBTitles, pr.Title)
		}
	}
	assert.ElementsMatch(t, []string{"old a", "new a"}, repoATitles)
	assert.ElementsMatch(t, []string{"b"}, repoBTitles, "repo b's data should be untouched by a's scoped refresh")
}

func TestAggregator_RefreshRepo_NoSourceForForge_ReturnsFalse(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource(dashboard.ForgeGitHub)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ok := agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "alrayyes", "a", "alrayyes/a")

	assert.False(t, ok, "no configured source drives forgejo, so the caller should fall back to a full refresh")
}

func TestAggregator_RefreshRepo_SourceDoesNotSupportScopedRefresh_ReturnsFalse(t *testing.T) {
	t.Parallel()

	// fakeSource (aggregator_test.go) implements Source but not
	// RepoRefresher — github.Client's own GraphQL path is in the same
	// position today.
	src := &fakeSource{result: dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}}
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	ok := agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.False(t, ok, "a source with no scoped-refresh support should signal the caller to fall back, not silently no-op")
}

func TestAggregator_RefreshRepo_ConcurrentCallsForSameRepo_Coalesce(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource(dashboard.ForgeGitHub)
	src.delay = 20 * time.Millisecond
	src.setRepo("alrayyes/a", nil, nil)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	const triggers = 5
	var wg sync.WaitGroup
	var oks atomic.Int64
	for range triggers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a") {
				oks.Add(1)
			}
		}()
	}
	wg.Wait()

	assert.Equal(t, int64(triggers), oks.Load(), "every caller should be told a scoped refresh handled its trigger")
	assert.LessOrEqual(t, src.repoFetchCallCount("alrayyes/a"), 2,
		"concurrent triggers for the same repo should coalesce, not fetch once per trigger")
}

func TestAggregator_RefreshRepo_UnrelatedRepoConcurrently_DoesNotWaitOnIt(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource(dashboard.ForgeGitHub)
	src.setRepo("alrayyes/a", nil, nil)
	src.setRepo("alrayyes/b", nil, nil)
	agg := dashboard.NewAggregator([]dashboard.Source{src})

	done := make(chan struct{})
	go func() {
		agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "b", "alrayyes/b")
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("a scoped refresh for one repo should not block on another repo's own coalescer key")
	}
}
