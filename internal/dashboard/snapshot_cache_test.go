package dashboard_test

import (
	"context"
	"errors"
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
}

func (m *memSnapshotCache) LoadSnapshotRepos(_ context.Context, forge dashboard.Forge, credential string) ([]dashboard.CachedRepo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	return append([]dashboard.CachedRepo(nil), m.rows[string(forge)+"|"+credential]...), m.loadErr
}

func (m *memSnapshotCache) SaveSnapshotRepos(_ context.Context, forge dashboard.Forge, credential string, repos []dashboard.CachedRepo) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string][]dashboard.CachedRepo{}
	}
	m.rows[string(forge)+"|"+credential] = append([]dashboard.CachedRepo(nil), repos...)

	return nil
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
