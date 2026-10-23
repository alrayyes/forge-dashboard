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

func TestService_Ensure_ThenGet_ReturnsItsSnapshot(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 5}}

	m := dashboard.NewService(10 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool {
		snap := m.Get()

		return len(snap.Forges) == 1 && snap.Forges[0].RepoCount == 5
	}, time.Second, 5*time.Millisecond)
}

func TestService_Get_NothingEnsured_ReturnsEmptySnapshotNotNil(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Minute)
	t.Cleanup(m.Stop)

	snap := m.Get()

	require.NotNil(t, snap.Forges)
	require.NotNil(t, snap.PullRequests)
	require.NotNil(t, snap.Issues)
	assert.Empty(t, snap.Forges)
}

func TestService_Ensure_Replacing_StopsTheOldRefreshLoop(t *testing.T) {
	t.Parallel()

	first := &countingSource{}
	second := &countingSource{}

	m := dashboard.NewService(5 * time.Millisecond)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{first})
	require.Eventually(t, func() bool { return first.calls.Load() >= 2 }, time.Second, 5*time.Millisecond)

	m.Ensure(t.Context(), []dashboard.Source{second})
	require.Eventually(t, func() bool { return second.calls.Load() >= 2 }, time.Second, 5*time.Millisecond)

	callsAtSwitch := first.calls.Load()
	time.Sleep(50 * time.Millisecond)
	assert.LessOrEqual(t, first.calls.Load(), callsAtSwitch+1, "the first source's refresh loop should have stopped, not kept running alongside the second")
}

func TestService_RefreshNow_Running_RefreshesImmediatelyAndReturnsTrue(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 7}}

	// An interval long enough that the assertion below would fail on its
	// own timing if RefreshNow weren't doing real, immediate work.
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond, "the initial refresh Ensure starts")

	ok := m.RefreshNow(t.Context())

	assert.True(t, ok)
	assert.Equal(t, int32(2), src.calls.Load(), "RefreshNow should have triggered one more fetch on top of Ensure's initial one")
}

func TestService_RefreshNow_NothingEnsured_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Minute)
	t.Cleanup(m.Stop)

	ok := m.RefreshNow(t.Context())

	assert.False(t, ok)
}

func TestService_RefreshRepo_Running_DelegatesToTheirAggregator(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1}})

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.fetchCallCount() >= 1 }, time.Second, 5*time.Millisecond)

	ok := m.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.True(t, ok)
	assert.Equal(t, 1, src.repoFetchCallCount("alrayyes/a"))
	assert.Equal(t, 1, src.fetchCallCount(), "a scoped refresh should not also trigger a full account-wide fetch")
}

func TestService_RefreshRepo_NothingEnsured_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Minute)
	t.Cleanup(m.Stop)

	ok := m.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a")

	assert.False(t, ok)
}

func TestService_Subscribe_Running_ReceivesUpdatesFromRefreshNow(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 3}}

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	updates, unsubscribe, ok := m.Subscribe()
	require.True(t, ok)
	defer unsubscribe()

	m.RefreshNow(t.Context())

	select {
	case snap := <-updates:
		require.Len(t, snap.Forges, 1)
		assert.Equal(t, 3, snap.Forges[0].RepoCount)
	case <-time.After(time.Second):
		t.Fatal("expected a snapshot on the subscription channel after RefreshNow")
	}
}

func TestService_Subscribe_NothingEnsured_ReturnsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Minute)
	t.Cleanup(m.Stop)

	_, _, ok := m.Subscribe()

	assert.False(t, ok)
}

// TestService_EnsureIfAbsent_ConcurrentCalls_OnlyCreateOneAggregator
// is a regression test for a real race: warmUpAggregator used to check
// Running() and, if false, separately call Ensure() - two unlocked
// operations with a DB read in between. Several requests for the same
// user landing in that gap (multiple browser tabs and an SSE reconnect,
// all arriving right after a restart wipes the Service clean) each saw
// "not running" and each spun up their own brand-new Aggregator with its
// own immediate Refresh.
func TestService_EnsureIfAbsent_ConcurrentCalls_OnlyCreateOneAggregator(t *testing.T) {
	t.Parallel()

	src := &countingSource{}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	const callers = 10
	var wg sync.WaitGroup
	for range callers {
		wg.Go(func() {
			m.EnsureIfAbsent(t.Context(), []dashboard.Source{src})
		})
	}
	wg.Wait()

	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)
	time.Sleep(20 * time.Millisecond)
	assert.Equal(t, int32(1), src.calls.Load(), "only one of the concurrent callers should have actually created an Aggregator and refreshed")
}

func TestService_EnsureIfAbsent_AlreadyRunning_NeverReplaces(t *testing.T) {
	t.Parallel()

	original := &countingSource{}
	replacement := &countingSource{}

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{original})
	require.Eventually(t, func() bool { return original.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	m.EnsureIfAbsent(t.Context(), []dashboard.Source{replacement})

	time.Sleep(20 * time.Millisecond)
	assert.Equal(t, int32(0), replacement.calls.Load(), "an already-running Aggregator should never be replaced by EnsureIfAbsent")
}

func TestService_SetAutoUpdateBranchLister_ThenEnsure_WiresItIntoTheAggregator(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}
	lister := &fakeAutoUpdateBranchLister{
		enabled: map[string]struct{}{"github/alrayyes/a": {}},
	}

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetAutoUpdateBranchLister(lister)

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool {
		return len(src.updatedBranches()) == 1
	}, time.Second, 5*time.Millisecond)
}

func TestService_Ensure_NoAutoUpdateBranchListerSet_NeverCallsUpdateBranch(t *testing.T) {
	t.Parallel()

	src := &fakeBranchUpdaterSource{fakeSource: fakeSource{result: dashboard.Result{ //nolint:modernize // fakeBranchUpdaterSource also carries mu/updated; an unkeyed literal would need every field, not just the embedded one
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true},
		PullRequests: []dashboard.PullRequest{
			{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, Behind: true},
		},
	}}}

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	// SetAutoUpdateBranchLister never called.

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool {
		forges := m.Get().Forges

		return len(forges) == 1 && forges[0].Reachable
	}, time.Second, 5*time.Millisecond)
	assert.Empty(t, src.updatedBranches())
}

// TestService_SetCIPollInterval_ThenEnsure_WiresItIntoTheAggregator is
// #177's own fix, at the Service level: SetCIPollInterval has to
// actually reach the Aggregator Ensure builds, not just be recorded
// and forgotten. A long Run interval (time.Hour) isolates PollCI's own
// scoped fetches from Run's full ones — repoFetchCallCount only moves
// on a PollCI tick.
func TestService_SetCIPollInterval_ThenEnsure_WiresItIntoTheAggregator(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending},
	})

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetCIPollInterval(10 * time.Millisecond)

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool {
		return src.repoFetchCallCount("alrayyes/a") >= 1
	}, time.Second, 5*time.Millisecond)
}

func TestService_Ensure_NoCIPollIntervalSet_NeverPolls(t *testing.T) {
	t.Parallel()

	src := newFakeRepoRefresherSource()
	src.setRepo("alrayyes/a", []dashboard.PullRequest{
		{Forge: dashboard.ForgeGitHub, Repo: "alrayyes/a", Number: 1, CI: dashboard.CIPending},
	})

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	// SetCIPollInterval never called.

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool {
		return src.fetchCallCount() >= 1
	}, time.Second, 5*time.Millisecond)
	assert.Equal(t, 0, src.repoFetchCallCount("alrayyes/a"))
}

// gatedSource blocks Fetch until release is closed, so a test can hold an
// Aggregator mid-way through its first refresh.
type gatedSource struct {
	release chan struct{}
	health  dashboard.ForgeHealth
}

func (s *gatedSource) Fetch(ctx context.Context) dashboard.Result {
	select {
	case <-s.release:
	case <-ctx.Done():
	}

	return dashboard.Result{Health: s.health}
}

func (s *gatedSource) Forge() dashboard.Forge { return s.health.Forge }

func TestService_FirstRefreshComplete_NoAggregatorYet_IsTrue(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	assert.True(t, m.FirstRefreshComplete(), "nothing has signed in, so there is no first refresh to wait for")
}

func TestService_FirstRefreshComplete_FalseUntilTheFirstRefreshFinishes(t *testing.T) {
	t.Parallel()

	src := &gatedSource{release: make(chan struct{})}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	assert.False(t, m.FirstRefreshComplete())

	close(src.release)

	require.Eventually(t, m.FirstRefreshComplete, time.Second, 5*time.Millisecond)
}

func TestService_FirstRefreshComplete_UnreachableForgeStillCounts(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, m.FirstRefreshComplete, time.Second, 5*time.Millisecond)
}

func TestService_FirstRefreshComplete_StaysTrueWhenAnotherAggregatorStarts(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{&countingSource{}})
	require.Eventually(t, m.FirstRefreshComplete, time.Second, 5*time.Millisecond)

	m.Ensure(t.Context(), []dashboard.Source{&gatedSource{release: make(chan struct{})}})

	assert.True(t, m.FirstRefreshComplete(), "a later replacement must not flip a serving container back to unready")
}

// A first refresh that is slow, or never finishes because a forge doesn't
// answer, must not keep the service unready (#893): readiness says it can
// serve, and how fast a forge answers is only how fresh the data is.
func TestService_FirstRefreshComplete_ReadyAfterTheGraceEvenIfTheRefreshIsStillRunning(t *testing.T) {
	t.Parallel()

	src := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(src.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetFirstRefreshGrace(30 * time.Millisecond)

	m.Ensure(t.Context(), []dashboard.Source{src})
	require.False(t, m.FirstRefreshComplete(), "not ready the moment the refresh starts")

	require.Eventually(t, m.FirstRefreshComplete, time.Second, 5*time.Millisecond,
		"the refresh is still blocked, but the grace has passed")
}

// A login or settings save during a slow first refresh replaces the Aggregator.
// The grace runs from the first start, so repeated saves can't keep readiness
// false past the configured window.
func TestService_FirstRefreshComplete_ReplacingTheAggregatorDoesNotRestartTheGrace(t *testing.T) {
	t.Parallel()

	blocked := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(blocked.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetFirstRefreshGrace(150 * time.Millisecond)

	start := time.Now()
	m.Ensure(t.Context(), []dashboard.Source{blocked})

	for time.Since(start) < 100*time.Millisecond {
		time.Sleep(20 * time.Millisecond)
		m.Ensure(t.Context(), []dashboard.Source{blocked})
	}
	require.False(t, m.FirstRefreshComplete(), "still inside the grace")

	time.Sleep(time.Until(start.Add(200 * time.Millisecond)))
	assert.True(t, m.FirstRefreshComplete(),
		"the grace ran from the first start, not from the latest Ensure")
}

// Stop only halts the loop, so the grace anchor survives a stop and a restart
// in the same process, like the other first-refresh marks.
func TestService_Stop_KeepsTheGraceAnchor(t *testing.T) {
	t.Parallel()

	blocked := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(blocked.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetFirstRefreshGrace(100 * time.Millisecond)

	start := time.Now()
	m.Ensure(t.Context(), []dashboard.Source{blocked})
	m.Stop()
	time.Sleep(time.Until(start.Add(150 * time.Millisecond)))
	m.Ensure(t.Context(), []dashboard.Source{blocked})

	assert.True(t, m.FirstRefreshComplete(),
		"the grace still runs from the first start after a stop")
}

// Reset is a fresh process, so the next start anchors the grace anew.
func TestService_Reset_ClearsTheGraceAnchor(t *testing.T) {
	t.Parallel()

	blocked := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(blocked.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetFirstRefreshGrace(100 * time.Millisecond)

	start := time.Now()
	m.Ensure(t.Context(), []dashboard.Source{blocked})
	m.Stop()
	m.Reset()
	time.Sleep(time.Until(start.Add(150 * time.Millisecond)))
	m.Ensure(t.Context(), []dashboard.Source{blocked})

	assert.False(t, m.FirstRefreshComplete(),
		"a reset anchors the grace on the next start")
}

func TestService_FirstRefreshComplete_AnAggregatorAddedLaterCannotUnreadyAServingProcess(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetFirstRefreshGrace(time.Hour)
	m.Ensure(t.Context(), []dashboard.Source{&countingSource{}})
	require.Eventually(t, m.FirstRefreshComplete, time.Second, 5*time.Millisecond)

	blocked := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(blocked.release) })
	m.Ensure(t.Context(), []dashboard.Source{blocked})

	assert.True(t, m.FirstRefreshComplete())
}

// firstRefreshDone is the flag the snapshot carries (#1673).

func TestService_FirstRefreshDone_NoAggregatorYet_IsFalse(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	assert.False(t, m.FirstRefreshDone())
}

func TestService_FirstRefreshDone_FalseWhileTheFirstRefreshRuns_TrueOnceItEnds(t *testing.T) {
	t.Parallel()

	src := &gatedSource{release: make(chan struct{})}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	assert.False(t, m.FirstRefreshDone())

	close(src.release)

	require.Eventually(t, func() bool { return m.FirstRefreshDone() }, time.Second, 5*time.Millisecond)
}

func TestService_FirstRefreshDone_UnreachableForgeStillCounts(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: false}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool { return m.FirstRefreshDone() }, time.Second, 5*time.Millisecond)
}

func TestService_FirstRefreshDone_StaysTrueWhenTheAggregatorIsReplaced(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{&countingSource{}})
	// Wait without reading the flag: the replacement itself must carry the mark.
	m.WaitFirstRefresh(t.Context(), time.Second)

	// A settings save rebuilds the Aggregator, and its first refresh is pending.
	m.Ensure(t.Context(), []dashboard.Source{&gatedSource{release: make(chan struct{})}})

	assert.True(t, m.FirstRefreshDone(), "a later refresh must not put the loading state back")
}

func TestService_Stop_KeepsTheFirstRefresh(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return m.FirstRefreshDone() }, time.Second, 5*time.Millisecond)

	m.Stop()

	assert.True(t, m.FirstRefreshDone(), "halting the loop is not a restart")
	assert.False(t, m.Running())
}

func TestService_Reset_ForgetsTheFirstRefresh(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return m.FirstRefreshDone() }, time.Second, 5*time.Millisecond)

	m.Stop()
	m.Reset()

	assert.False(t, m.FirstRefreshDone(), "a reset Service reads like a fresh process")
}

// A login that read the saved credentials just before a save must not win the
// swap afterwards: the read happens under the same lock as the swap, so the
// save's Ensure queues behind it and lands last.
func TestService_EnsureFrom_ReadsUnderTheSwapLock_SoALaterSaveWins(t *testing.T) {
	t.Parallel()

	oldSrc := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}}
	newSrc := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 2}}

	var saved atomic.Pointer[countingSource]
	saved.Store(oldSrc)

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	readOld := make(chan struct{})
	release := make(chan struct{})
	loginDone := make(chan struct{})

	go func() {
		defer close(loginDone)

		m.EnsureFrom(t.Context(), func() ([]dashboard.Source, bool) {
			src := saved.Load()

			close(readOld)
			<-release

			return []dashboard.Source{src}, true
		})
	}()

	<-readOld

	saveDone := make(chan struct{})
	saveStarted := make(chan struct{})

	go func() {
		defer close(saveDone)

		saved.Store(newSrc)
		close(saveStarted)
		m.Ensure(t.Context(), []dashboard.Source{newSrc})
	}()

	<-saveStarted

	// Give the save time to finish if nothing stops it. It must instead be
	// parked on the Service lock the login's loader still holds.
	select {
	case <-saveDone:
		t.Fatal("the save swapped the aggregator while the login's read was still in flight")
	case <-time.After(100 * time.Millisecond):
	}

	close(release)
	<-loginDone
	<-saveDone

	require.Eventually(t, func() bool { return len(m.Get().Forges) == 1 && m.Get().Forges[0].RepoCount == 2 }, 2*time.Second, 5*time.Millisecond)
}

func TestService_EnsureFrom_LoaderDeclines_KeepsTheRunningAggregator(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true, RepoCount: 1}}

	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{src})
	m.EnsureFrom(t.Context(), func() ([]dashboard.Source, bool) { return nil, false })

	require.True(t, m.Running())
	require.Eventually(t, func() bool { return len(m.Get().Forges) == 1 }, 2*time.Second, 5*time.Millisecond)
}

func TestService_StartAtBoot_RefreshesWithoutAnyRequest(t *testing.T) {
	t.Parallel()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.StartAtBoot(t.Context(), []dashboard.Source{src})

	require.Eventually(t, func() bool { return src.calls.Load() > 0 }, time.Second, 5*time.Millisecond)
}

func TestService_StartAtBoot_KeepsAnAggregatorThatIsAlreadyRunning(t *testing.T) {
	t.Parallel()

	first := &countingSource{}
	second := &countingSource{}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.Ensure(t.Context(), []dashboard.Source{first})
	m.StartAtBoot(t.Context(), []dashboard.Source{second})

	require.Eventually(t, func() bool { return first.calls.Load() > 0 }, time.Second, 5*time.Millisecond)
	assert.Zero(t, second.calls.Load())
}

// Readiness says the app can serve its saved view, so a refresh the process
// started for itself must not hold it back while a forge is slow.
func TestService_StartAtBoot_ReadinessDoesNotWaitForTheRefresh(t *testing.T) {
	t.Parallel()

	src := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(src.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.StartAtBoot(t.Context(), []dashboard.Source{src})

	assert.True(t, m.FirstRefreshComplete(), "the refresh is still blocked, and the service can serve")
}

func TestService_Reset_ReadinessWaitsForARefreshAgainAfterABootStart(t *testing.T) {
	t.Parallel()

	src := &gatedSource{release: make(chan struct{})}
	t.Cleanup(func() { close(src.release) })
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)

	m.StartAtBoot(t.Context(), []dashboard.Source{src})
	m.Stop()
	m.Reset()
	m.Ensure(t.Context(), []dashboard.Source{src})

	assert.False(t, m.FirstRefreshComplete(), "a sign-in's refresh gates readiness again on a fresh process")
}
