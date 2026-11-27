package dashboard_test

import (
	"context"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// What applying a late read keeps to, beyond putting its rows on the board.

// scopedCtxSource is a ctxSource that can also read one repository, where it
// finds #12. block, when set, holds that read until it is closed.
type scopedCtxSource struct {
	*ctxSource

	entered chan struct{}
	block   chan struct{}
}

func (s *scopedCtxSource) FetchRepo(context.Context, string, string, string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	if s.block != nil {
		close(s.entered)
		<-s.block
	}

	return []dashboard.PullRequest{{Forge: s.Forge(), Repo: "o/r", Number: 12}}, nil, nil
}

// newScopedFixture has read its forge once and made it slow.
func newScopedFixture(t *testing.T, block chan struct{}) (lateFixture, *scopedCtxSource) {
	t.Helper()

	f := lateFixture{src: newCtxSource(), timers: newFakeTimers()}
	src := &scopedCtxSource{ctxSource: f.src, entered: make(chan struct{}), block: block}
	f.agg = dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline))
	f.agg.Refresh(t.Context())
	f.src.slow.Store(true)

	return f, src
}

// applied waits for the late read's outcome to be on the board.
func (f lateFixture) applied(t *testing.T) {
	t.Helper()

	f.shows(t, func(s dashboard.Snapshot) bool { return health(s, dashboard.ForgeForgejo).Cause == "" })
}

// A webhook read made while the late read ran is newer than it.
func TestAggregator_ALateReadKeepsARepositoryReadSinceItBegan(t *testing.T) {
	t.Parallel()
	f, _ := newScopedFixture(t, nil)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	require.True(t, f.agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "r", "o/r"))

	f.src.answer <- f.src.rows(11)

	f.applied(t)
	assert.Equal(t, []int{12}, numbers(f.agg.Get()))
}

// A webhook read begun before the late read is older than it.
func TestAggregator_AScopedReadOlderThanALateReadIsDropped(t *testing.T) {
	t.Parallel()
	block := make(chan struct{})
	f, src := newScopedFixture(t, block)
	scoped := make(chan struct{})
	go func() {
		defer close(scoped)
		f.agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "r", "o/r")
	}()
	<-src.entered
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	f.src.answer <- f.src.rows(11)
	f.shows(t, hasLateRow)

	close(block)
	<-scoped

	assert.Equal(t, []int{11}, numbers(f.agg.Get()))
}

// A full refresh that read the forge while the late read was still on its way
// to the board is newer than it.
func TestAggregator_ALateReadOvertakenByAFullRefreshIsDropped(t *testing.T) {
	t.Parallel()
	f, src := newAckFixture(t)
	f.src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	requestRebase(f)
	overtaken := make(chan struct{})
	overtake := func() {
		defer close(overtaken)
		f.src.slow.Store(false)
		f.agg.Refresh(t.Context())
	}
	src.onAck.Store(&overtake)

	f.src.answer <- f.src.rows(11)
	<-overtaken

	assert.Never(t, func() bool { return hasLateRow(f.agg.Get()) }, 200*time.Millisecond, time.Millisecond)
}

// updatingCtxSource is a ctxSource that can update a branch.
type updatingCtxSource struct {
	*ctxSource

	updated chan int
}

func (s *updatingCtxSource) UpdateBranch(_ context.Context, _, _ string, number int) (bool, error) {
	s.updated <- number

	return false, nil
}

// The writes that follow any refresh follow a late read too.
func TestAggregator_ALateReadRunsTheBranchUpdates(t *testing.T) {
	t.Parallel()
	f := lateFixture{src: newCtxSource(), timers: newFakeTimers()}
	src := &updatingCtxSource{ctxSource: f.src, updated: make(chan int, 4)}
	f.agg = dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithClock(f.timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, f.timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline))
	f.agg.EnableAutoUpdateBranch(&fakeAutoUpdateBranchLister{enabled: map[string]struct{}{"forgejo/o/r": {}}})
	f.agg.Refresh(t.Context())
	f.src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	res := f.src.rows(11)
	res.PullRequests[0].Behind = true

	f.src.answer <- res

	select {
	case n := <-src.updated:
		assert.Equal(t, 11, n)
	case <-time.After(10 * time.Second):
		t.Fatal("no branch update followed the late read")
	}
}

func TestAggregator_ALateReadIsSavedForTheNextStart(t *testing.T) {
	t.Parallel()
	cache := &memSnapshotCache{}
	f := newLateFixture(t, dashboard.WithSnapshotCache(cache))
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	f.src.answer <- f.src.rows(11)

	require.Eventually(t, func() bool {
		restarted := dashboard.NewAggregator([]dashboard.Source{newCtxSource()}, dashboard.WithSnapshotCache(cache))

		return hasLateRow(restarted.Get())
	}, 10*time.Second, time.Millisecond)
}

// What a late read spent counts towards holding the next scheduled one back.
func TestAggregator_ALateReadsSpendIsCounted(t *testing.T) {
	t.Parallel()
	f := newLateFixture(t)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })
	res := f.src.rows(11)
	res.Spent = &dashboard.Spend{REST: 200}
	// 600 left of 5000: above the reserve of 500, but not by what a read costs.
	res.Health.RateLimitREST = &dashboard.RateLimit{Limit: 5000, Remaining: 600, ResetsAt: f.timers.Now().Add(time.Hour)}
	f.src.answer <- res
	f.shows(t, hasLateRow)
	f.src.slow.Store(false)

	// The spend is noted just after the rows are shown.
	require.Eventually(t, func() bool {
		before := f.src.calls.Load()
		f.agg.Refresh(dashboard.BackgroundForTest(t.Context()))

		return f.src.calls.Load() == before
	}, 10*time.Second, 10*time.Millisecond)
}
