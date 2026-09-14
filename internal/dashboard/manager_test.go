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

type countingSource struct {
	calls  atomic.Int32
	health dashboard.ForgeHealth
}

func (s *countingSource) Fetch(_ context.Context) dashboard.Result {
	s.calls.Add(1)
	return dashboard.Result{Health: s.health}
}

func (s *countingSource) Forge() dashboard.Forge { return s.health.Forge }

func TestManager_Ensure_ThenGet_ReturnsThatUsersSnapshot(t *testing.T) {
	t.Parallel()

	userA := []byte("user-a")
	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 5}}

	m := dashboard.NewManager(10 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), userA, []dashboard.Source{src})

	require.Eventually(t, func() bool {
		snap := m.Get(userA)
		return len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 5
	}, time.Second, 5*time.Millisecond)
}

func TestManager_Get_UnknownUser_ReturnsEmptySnapshotNotNil(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	snap := m.Get([]byte("nobody"))

	require.NotNil(t, snap.Forges)
	require.NotNil(t, snap.PullRequests)
	require.NotNil(t, snap.Issues)
	assert.Empty(t, snap.Forges)
}

func TestManager_Ensure_ReplacingAUser_StopsTheOldRefreshLoop(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	first := &countingSource{}
	second := &countingSource{}

	m := dashboard.NewManager(5 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{first})
	require.Eventually(t, func() bool { return first.calls.Load() >= 2 }, time.Second, 5*time.Millisecond)

	m.Ensure(t.Context(), user, []dashboard.Source{second})
	require.Eventually(t, func() bool { return second.calls.Load() >= 2 }, time.Second, 5*time.Millisecond)

	callsAtSwitch := first.calls.Load()
	time.Sleep(50 * time.Millisecond)
	assert.LessOrEqual(t, first.calls.Load(), callsAtSwitch+1, "the first source's refresh loop should have stopped, not kept running alongside the second")
}

func TestManager_Remove_StopsTheRefreshLoopAndEvictsTheSnapshot(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, RepoCount: 1}}

	m := dashboard.NewManager(5 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 2 }, time.Second, 5*time.Millisecond)

	m.Remove(user)

	callsAtRemoval := src.calls.Load()
	time.Sleep(50 * time.Millisecond)
	assert.LessOrEqual(t, src.calls.Load(), callsAtRemoval+1, "the refresh loop should have stopped, not kept running after Remove")

	snap := m.Get(user)
	assert.Empty(t, snap.Forges, "a removed user's snapshot should be gone, not the last one it fetched")
}

func TestManager_Remove_UnknownUser_IsANoOp(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	assert.NotPanics(t, func() { m.Remove([]byte("nobody")) })
}

func TestManager_RefreshNow_KnownUser_RefreshesImmediatelyAndReturnsTrue(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 7}}

	// An interval long enough that the assertion below would fail on its
	// own timing if RefreshNow weren't doing real, immediate work.
	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond, "the initial refresh Ensure starts")

	ok := m.RefreshNow(t.Context(), user)

	assert.True(t, ok)
	assert.Equal(t, int32(2), src.calls.Load(), "RefreshNow should have triggered one more fetch on top of Ensure's initial one")
}

func TestManager_RefreshNow_UnknownUser_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	ok := m.RefreshNow(t.Context(), []byte("nobody"))

	assert.False(t, ok)
}

func TestManager_RefreshRepo_KnownUser_DelegatesToTheirAggregator(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	src := newFakeRepoRefresherSource(dashboard.ForgeGitHub)
	src.setRepo("alrayyes/a", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}}, nil)

	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.fetchCallCount() >= 1 }, time.Second, 5*time.Millisecond)

	ok := m.RefreshRepo(t.Context(), user, dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.True(t, ok)
	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"))
	assert.Equal(t, 1, src.fetchCallCount(), "a scoped refresh should not also trigger a full account-wide fetch")
}

func TestManager_RefreshRepo_UnknownUser_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	ok := m.RefreshRepo(t.Context(), []byte("nobody"), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.False(t, ok)
}

func TestManager_Subscribe_KnownUser_ReceivesUpdatesFromRefreshNow(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}}

	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	updates, unsubscribe, ok := m.Subscribe(user)
	require.True(t, ok)
	defer unsubscribe()

	m.RefreshNow(t.Context(), user)

	select {
	case snap := <-updates:
		require.Len(t, snap.Forges, 1)
		assert.Equal(t, 3, snap.Forges[0].RepoCount)
	case <-time.After(time.Second):
		t.Fatal("expected a snapshot on the subscription channel after RefreshNow")
	}
}

func TestManager_Subscribe_UnknownUser_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	_, _, ok := m.Subscribe([]byte("nobody"))

	assert.False(t, ok)
}

func TestManager_TwoUsers_HaveIndependentSnapshots(t *testing.T) {
	t.Parallel()

	userA, userB := []byte("user-a"), []byte("user-b")
	srcA := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, RepoCount: 1}}
	srcB := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, RepoCount: 2}}

	m := dashboard.NewManager(10 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), userA, []dashboard.Source{srcA})
	m.Ensure(t.Context(), userB, []dashboard.Source{srcB})

	require.Eventually(t, func() bool {
		return len(m.Get(userA).Forges) == 1 && len(m.Get(userB).Forges) == 1
	}, time.Second, 5*time.Millisecond)

	assert.Equal(t, 1, m.Get(userA).Forges[0].RepoCount)
	assert.Equal(t, 2, m.Get(userB).Forges[0].RepoCount)
}

// TestManager_EnsureIfAbsent_ConcurrentCallsForNewUser_OnlyCreateOneAggregator
// is a regression test for a real race: warmUpAggregator used to check
// Running() and, if false, separately call Ensure() - two unlocked
// operations with a DB read in between. Several requests for the same
// user landing in that gap (multiple browser tabs and an SSE reconnect,
// all arriving right after a restart wipes the Manager clean) each saw
// "not running" and each spun up their own brand-new Aggregator with its
// own immediate Refresh.
func TestManager_EnsureIfAbsent_ConcurrentCallsForNewUser_OnlyCreateOneAggregator(t *testing.T) {
	t.Parallel()

	user := []byte("user-new")
	src := &countingSource{}
	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)

	const callers = 10
	var wg sync.WaitGroup
	for range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.EnsureIfAbsent(t.Context(), user, []dashboard.Source{src})
		}()
	}
	wg.Wait()

	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	assert.Equal(t, int32(1), src.calls.Load(), "only one of the concurrent callers should have actually created an Aggregator and refreshed")
}

func TestManager_EnsureIfAbsent_AlreadyRunning_NeverReplaces(t *testing.T) {
	t.Parallel()

	user := []byte("user-a")
	original := &countingSource{}
	replacement := &countingSource{}

	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), user, []dashboard.Source{original})
	require.Eventually(t, func() bool { return original.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	m.EnsureIfAbsent(t.Context(), user, []dashboard.Source{replacement})

	time.Sleep(20 * time.Millisecond)
	assert.Equal(t, int32(0), replacement.calls.Load(), "an already-running Aggregator should never be replaced by EnsureIfAbsent")
}
