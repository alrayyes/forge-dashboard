package dashboard_test

import (
	"context"
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
