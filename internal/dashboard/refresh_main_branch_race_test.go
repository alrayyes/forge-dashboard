package dashboard_test

import (
	"context"
	"errors"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// gatedBranchSource is a branchRefreshingSource whose next full Fetch reads the
// forge and then holds its answer until released.
type gatedBranchSource struct {
	*branchRefreshingSource

	started chan struct{}
	release chan struct{}
}

func (g *gatedBranchSource) Fetch(ctx context.Context) dashboard.Result {
	result := g.branchRefreshingSource.Fetch(ctx)
	if started, release := g.started, g.release; started != nil {
		g.started = nil
		close(started)
		<-release
	}

	return result
}

// startFullRead returns once a full refresh has read the forge and is holding
// that answer. finish lets it answer and waits for the refresh to end.
func (g *gatedBranchSource) startFullRead(t *testing.T, agg *dashboard.Aggregator) (finish func()) {
	t.Helper()

	started, release, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	g.started, g.release = started, release
	go func() {
		defer close(done)
		agg.Refresh(t.Context())
	}()
	<-started

	return func() {
		close(release)
		<-done
	}
}

// set changes what alrayyes/a's branch reads as, in full and on its own.
func (g *gatedBranchSource) set(polled, current dashboard.MainBranchStatus, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.polled["alrayyes/a"], g.current["alrayyes/a"], g.err = polled, current, err
}

func newGatedBranchFixture(t *testing.T) (*gatedBranchSource, *dashboard.Aggregator) {
	t.Helper()

	src := &gatedBranchSource{branchRefreshingSource: newBranchRefreshingSource()}
	agg := dashboard.NewAggregator([]dashboard.Source{src})
	agg.Refresh(t.Context())

	return src, agg
}

func refreshA(t *testing.T, agg *dashboard.Aggregator) {
	t.Helper()

	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))
}

func TestAggregator_AnOlderFullReadKeepsANewerMainBranchRow(t *testing.T) {
	t.Parallel()
	src, agg := newGatedBranchFixture(t)
	finish := src.startFullRead(t, agg)

	refreshA(t, agg)
	require.Equal(t, dashboard.MainBranchPassed, branchStatuses(agg.Get())["alrayyes/a"])
	finish()

	assert.Equal(t, dashboard.MainBranchPassed, branchStatuses(agg.Get())["alrayyes/a"])
	assert.Len(t, agg.Get().MainBranches, 2, "one row per repo")
}

func TestAggregator_AFullReadStartedAfterAScopedRefreshAppliesItsMainBranchRow(t *testing.T) {
	t.Parallel()
	src, agg := newGatedBranchFixture(t)
	refreshA(t, agg)

	src.set(dashboard.MainBranchRunning, dashboard.MainBranchPassed, nil)
	src.startFullRead(t, agg)()

	assert.Equal(t, dashboard.MainBranchRunning, branchStatuses(agg.Get())["alrayyes/a"])
}

// A scoped refresh that could not read the branch wrote no row, so it has
// nothing to defend: the full read's row is newer than the one on show.
func TestAggregator_AFailedScopedBranchReadLetsTheFullReadsRowThrough(t *testing.T) {
	t.Parallel()
	src, agg := newGatedBranchFixture(t)
	src.set(dashboard.MainBranchRunning, dashboard.MainBranchPassed, errors.New("boom"))
	finish := src.startFullRead(t, agg)

	refreshA(t, agg)
	require.Equal(t, dashboard.MainBranchFailed, branchStatuses(agg.Get())["alrayyes/a"])
	finish()

	assert.Equal(t, dashboard.MainBranchRunning, branchStatuses(agg.Get())["alrayyes/a"])
}

func TestAggregator_AFailedScopedBranchReadKeepsAnEarlierScopedRowOverTheFullReads(t *testing.T) {
	t.Parallel()
	src, agg := newGatedBranchFixture(t)
	finish := src.startFullRead(t, agg)

	refreshA(t, agg)
	src.set(dashboard.MainBranchFailed, dashboard.MainBranchPassed, errors.New("boom"))
	refreshA(t, agg)
	finish()

	assert.Equal(t, dashboard.MainBranchPassed, branchStatuses(agg.Get())["alrayyes/a"])
}

// lateBranchSource is a ctxSource that can also re-read one repo.
type lateBranchSource struct{ *ctxSource }

func (s lateBranchSource) FetchRepo(context.Context, string, string, string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return s.rows(10).PullRequests, nil, nil
}

func (s lateBranchSource) FetchMainBranch(context.Context, string, string, string) (dashboard.MainBranch, error) {
	return s.branch(dashboard.MainBranchPassed), nil
}

func (s lateBranchSource) branch(status dashboard.MainBranchStatus) dashboard.MainBranch {
	return dashboard.MainBranch{Forge: s.Forge(), FullName: "o/r", Branch: "main", Status: status, FailingJobs: []string{}}
}

// The read a person's refresh stopped waiting for is older still (#5059).
func TestAggregator_ALateReadKeepsANewerMainBranchRow(t *testing.T) {
	t.Parallel()
	src := lateBranchSource{newCtxSource()}
	timers := newFakeTimers()
	f := lateFixture{src: src.ctxSource, timers: timers, agg: dashboard.NewAggregator([]dashboard.Source{src},
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(lateScheduledDeadline, timers.After),
		dashboard.WithUserFetchDeadline(lateUserDeadline),
	)}
	f.agg.Refresh(t.Context())
	src.slow.Store(true)
	f.giveUp(t, func() { f.agg.Refresh(t.Context()) })

	require.True(t, f.agg.RefreshRepo(t.Context(), src.Forge(), "o", "r", "o/r"))
	late := src.rows(11)
	late.MainBranches = []dashboard.MainBranch{src.branch(dashboard.MainBranchFailed)}
	src.answer <- late

	// The repo's pull requests stay the scoped ones, so wait for the slow mark
	// to end instead of for a late row.
	f.shows(t, func(snap dashboard.Snapshot) bool { return health(snap, src.Forge()).Cause == "" })
	assert.Equal(t, dashboard.MainBranchPassed, branchStatuses(f.agg.Get())["o/r"])
}
