package dashboard_test

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// memSnapshotCache is an in-memory SnapshotCache. The rows outlive any one
// Aggregator, the way the table outlives a restart.
type memSnapshotCache struct {
	mu      sync.Mutex
	rows    map[string][]dashboard.CachedRepo
	loadErr error
	// written and removed log every repo a save wrote or removed, in order.
	written []string
	removed []string
}

func (m *memSnapshotCache) LoadSnapshotRepos(_ context.Context, forge dashboard.Forge, credential string) ([]dashboard.CachedRepo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	return append([]dashboard.CachedRepo(nil), m.rows[string(forge)+"|"+credential]...), m.loadErr
}

func (m *memSnapshotCache) SaveSnapshotChanges(_ context.Context, forge dashboard.Forge, credential string, changed []dashboard.CachedRepo, removed []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string][]dashboard.CachedRepo{}
	}
	key := string(forge) + "|" + credential
	var kept []dashboard.CachedRepo
	for _, r := range m.rows[key] {
		if !slices.Contains(removed, r.Repo) && !slices.ContainsFunc(changed, func(c dashboard.CachedRepo) bool { return c.Repo == r.Repo }) {
			kept = append(kept, r)
		}
	}
	m.rows[key] = append(kept, changed...)
	for _, r := range changed {
		m.written = append(m.written, r.Repo)
	}
	m.removed = append(m.removed, removed...)

	return nil
}

func (m *memSnapshotCache) writes() (written, removed []string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	return append([]string(nil), m.written...), append([]string(nil), m.removed...)
}

// savedByAFirstRun returns a cache holding what a run with pull requests 1 and
// 2 left behind.
func savedByAFirstRun(t *testing.T) *memSnapshotCache {
	t.Helper()
	cache := &memSnapshotCache{}
	first := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub, prs: []int{1, 2}}},
		dashboard.WithSnapshotCache(cache),
	)
	first.Refresh(t.Context())

	return cache
}

func TestAggregator_AfterARestart_ServesTheSavedSnapshotMarkedStale(t *testing.T) {
	t.Parallel()
	cache := savedByAFirstRun(t)

	restarted := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub, prs: []int{1, 2}}},
		dashboard.WithSnapshotCache(cache),
	)

	snap := restarted.Get()
	assert.ElementsMatch(t, []int{1, 2}, numbers(snap))
	require.Len(t, snap.Repos, 1)
	require.NotNil(t, snap.Repos[0].StaleSince, "the repo says when its rows were fetched")
	h := health(snap, dashboard.ForgeGitHub)
	assert.False(t, h.Reachable)
	require.NotNil(t, h.StaleSince)
	assert.False(t, restarted.FirstRefreshDone(), "readiness still waits for a real refresh")
}

func TestAggregator_AfterARestart_TheFirstGoodRefreshClearsTheStaleMark(t *testing.T) {
	t.Parallel()
	cache := savedByAFirstRun(t)
	restarted := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub, prs: []int{3}}},
		dashboard.WithSnapshotCache(cache),
	)

	restarted.Refresh(t.Context())

	snap := restarted.Get()
	assert.Equal(t, []int{3}, numbers(snap))
	h := health(snap, dashboard.ForgeGitHub)
	assert.True(t, h.Reachable)
	assert.Nil(t, h.StaleSince)
	require.Len(t, snap.Repos, 1)
	assert.Nil(t, snap.Repos[0].StaleSince)
}

func TestAggregator_AfterARestart_AFailedFirstRefreshKeepsTheSavedSnapshot(t *testing.T) {
	t.Parallel()
	cache := savedByAFirstRun(t)
	down := &flakySource{forge: dashboard.ForgeGitHub}
	down.set(true)
	restarted := dashboard.NewAggregator([]dashboard.Source{down}, dashboard.WithSnapshotCache(cache))

	restarted.Refresh(t.Context())

	snap := restarted.Get()
	assert.ElementsMatch(t, []int{1, 2}, numbers(snap))
	assert.NotNil(t, health(snap, dashboard.ForgeGitHub).StaleSince)
}

func TestAggregator_AfterARestart_APageDoesNotWaitForTheFirstRefresh(t *testing.T) {
	t.Parallel()
	cache := savedByAFirstRun(t)
	restarted := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub}},
		dashboard.WithSnapshotCache(cache),
	)
	start := time.Now()

	restarted.WaitFirstRefresh(t.Context(), time.Minute)

	assert.Less(t, time.Since(start), 5*time.Second)
}

func TestAggregator_UnreadableSavedRows_StartEmpty(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{rows: map[string][]dashboard.CachedRepo{
		"github|": {{Repo: "o/r", FetchedAt: time.Now(), Payload: []byte("not json")}},
	}}

	agg := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub}},
		dashboard.WithSnapshotCache(cache),
	)

	snap := agg.Get()
	assert.Empty(t, snap.PullRequests)
	assert.Empty(t, snap.Forges)
}

func TestAggregator_AFailingCacheRead_StartsEmpty(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{loadErr: errors.New("disk gone")}

	agg := dashboard.NewAggregator(
		[]dashboard.Source{&flakySource{forge: dashboard.ForgeGitHub}},
		dashboard.WithSnapshotCache(cache),
	)

	assert.Empty(t, agg.Get().Forges)
}

func TestAggregator_ARepoNoLongerTracked_DropsOutOfTheSavedRows(t *testing.T) {
	t.Parallel()
	cache := savedByAFirstRun(t)
	none := &flakySource{forge: dashboard.ForgeGitHub}
	agg := dashboard.NewAggregator([]dashboard.Source{noReposSource{none}}, dashboard.WithSnapshotCache(cache))

	agg.Refresh(t.Context())

	rows, err := cache.LoadSnapshotRepos(t.Context(), dashboard.ForgeGitHub, "")
	require.NoError(t, err)
	assert.Empty(t, rows)
}

// noReposSource reaches its forge and finds nothing tracked.
type noReposSource struct{ *flakySource }

func (noReposSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

// twoRepoSource answers with one pull request in each of o/a and o/b.
type twoRepoSource struct {
	forge    dashboard.Forge
	mu       sync.Mutex
	titleOfA string
	dropB    bool
}

func (s *twoRepoSource) Forge() dashboard.Forge { return s.forge }

func (s *twoRepoSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true}}
	res.Repos = []dashboard.Repo{{Forge: s.forge, FullName: "o/a"}}
	res.PullRequests = []dashboard.PullRequest{{Forge: s.forge, Repo: "o/a", Number: 1, Title: s.titleOfA}}
	if !s.dropB {
		res.Repos = append(res.Repos, dashboard.Repo{Forge: s.forge, FullName: "o/b"})
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: s.forge, Repo: "o/b", Number: 2})
	}

	return res
}

func (s *twoRepoSource) set(titleOfA string, dropB bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.titleOfA, s.dropB = titleOfA, dropB
}

func TestAggregator_ARefreshThatFindsARepoUnchangedDoesNotRewriteIt(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{}
	src := &twoRepoSource{forge: dashboard.ForgeGitHub, titleOfA: "one"}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithSnapshotCache(cache))
	agg.Refresh(t.Context())

	agg.Refresh(t.Context())

	written, _ := cache.writes()
	assert.ElementsMatch(t, []string{"o/a", "o/b"}, written, "each repo is written once, by the first refresh")
}

func TestAggregator_ARefreshRewritesOnlyTheRepoThatChanged(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{}
	src := &twoRepoSource{forge: dashboard.ForgeGitHub, titleOfA: "one"}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithSnapshotCache(cache))
	agg.Refresh(t.Context())

	src.set("renamed", false)
	agg.Refresh(t.Context())

	written, _ := cache.writes()
	assert.Equal(t, []string{"o/a", "o/b", "o/a"}, written)
}

func TestAggregator_ARefreshRemovesOnlyTheRepoThatWentAway(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{}
	src := &twoRepoSource{forge: dashboard.ForgeGitHub, titleOfA: "one"}
	agg := dashboard.NewAggregator([]dashboard.Source{src}, dashboard.WithSnapshotCache(cache))
	agg.Refresh(t.Context())

	src.set("one", true)
	agg.Refresh(t.Context())

	written, removed := cache.writes()
	assert.ElementsMatch(t, []string{"o/a", "o/b"}, written)
	assert.Equal(t, []string{"o/b"}, removed)
	rows, err := cache.LoadSnapshotRepos(t.Context(), dashboard.ForgeGitHub, "")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.Equal(t, "o/a", rows[0].Repo)
}

func TestAggregator_AfterARestart_AnUnchangedRepoIsNotRewritten(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{}
	first := dashboard.NewAggregator([]dashboard.Source{&twoRepoSource{forge: dashboard.ForgeGitHub, titleOfA: "one"}}, dashboard.WithSnapshotCache(cache))
	first.Refresh(t.Context())
	before, _ := cache.writes()

	restarted := dashboard.NewAggregator([]dashboard.Source{&twoRepoSource{forge: dashboard.ForgeGitHub, titleOfA: "one"}}, dashboard.WithSnapshotCache(cache))
	restarted.Refresh(t.Context())

	after, _ := cache.writes()
	assert.Len(t, after, len(before), "what the database holds is already right")
}
