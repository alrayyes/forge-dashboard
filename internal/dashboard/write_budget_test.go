package dashboard_test

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// writeSource is a Forgejo source whose pull requests are all behind and ready
// to merge, and whose branch update and merge hang until release is closed.
// With honourCtx they also end when their context does, the way a real HTTP
// call does; without it, they ignore the context, the worst a stuck forge can do.
type writeSource struct {
	mu         sync.Mutex
	prs        []int
	calls      []int
	merges     []int
	tags       []string
	honourCtx  bool
	entered    chan int
	returned   chan error
	release    chan struct{}
	releaseOne sync.Once
}

func newWriteSource(honourCtx bool, prs ...int) *writeSource {
	return &writeSource{
		prs:       prs,
		honourCtx: honourCtx,
		entered:   make(chan int, 16),
		returned:  make(chan error, 16),
		release:   make(chan struct{}),
	}
}

func (s *writeSource) Forge() dashboard.Forge { return dashboard.ForgeForgejo }

func (s *writeSource) setPRs(prs ...int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prs = prs
}

func (s *writeSource) unblock() { s.releaseOne.Do(func() { close(s.release) }) }

func (s *writeSource) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return len(s.calls)
}

// callTags is the refresh tag each update call's context carried, in call
// order.
func (s *writeSource) callTags() []string {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]string(nil), s.tags...)
}

// tagKey marks a context with the refresh that made it, the way a request id
// or a logger would travel with it.
type tagKey struct{}

func tagged(ctx context.Context, tag string) context.Context {
	return context.WithValue(ctx, tagKey{}, tag)
}

func tagFrom(ctx context.Context) string {
	tag, _ := ctx.Value(tagKey{}).(string)

	return tag
}

func (s *writeSource) mergedNumbers() []int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return append([]int(nil), s.merges...)
}

func (s *writeSource) pullRequests() []dashboard.PullRequest {
	s.mu.Lock()
	prs := append([]int(nil), s.prs...)
	s.mu.Unlock()

	var out []dashboard.PullRequest
	for _, n := range prs {
		out = append(out, dashboard.PullRequest{
			Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: n, Behind: true,
			CI: dashboard.CISuccess, MergeStatus: dashboard.MergeMergeable,
		})
	}

	return out
}

func (s *writeSource) Fetch(context.Context) dashboard.Result {
	return dashboard.Result{
		Health:       dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:        []dashboard.Repo{{Forge: dashboard.ForgeForgejo, FullName: "o/r"}},
		PullRequests: s.pullRequests(),
	}
}

func (s *writeSource) FetchRepo(context.Context, string, string, string) ([]dashboard.PullRequest, []dashboard.Issue, error) {
	return s.pullRequests(), nil, nil
}

func (s *writeSource) UpdateBranch(ctx context.Context, _, _ string, number int) (bool, error) {
	s.mu.Lock()
	s.calls = append(s.calls, number)
	s.tags = append(s.tags, tagFrom(ctx))
	s.mu.Unlock()

	return false, s.hang(ctx, number)
}

func (s *writeSource) MergePullRequest(ctx context.Context, _, _ string, number int) error {
	s.mu.Lock()
	s.merges = append(s.merges, number)
	s.mu.Unlock()

	return s.hang(ctx, number)
}

// hang blocks the way a stuck forge does, and reports how it ended.
func (s *writeSource) hang(ctx context.Context, number int) error {
	s.entered <- number

	var err error
	if s.honourCtx {
		select {
		case <-ctx.Done():
			err = ctx.Err()
		case <-s.release:
		}
	} else {
		<-s.release
	}
	s.returned <- err
	if err != nil {
		return fmt.Errorf("hung write: %w", err)
	}

	return nil
}

const writeBudget = time.Minute

// writeFixture is an aggregator over one writeSource whose clock and write
// budget the test drives by hand.
type writeFixture struct {
	agg    *dashboard.Aggregator
	src    *writeSource
	timers *fakeTimers
}

// newWriteFixture builds the aggregator with the passes the test asks for:
// updating enables auto update-branch for o/r, and armed, when not nil,
// enables auto-merge for those pull requests ("forgejo/o/r#1").
func newWriteFixture(t *testing.T, honourCtx, updating bool, armed []string, prs ...int) writeFixture {
	t.Helper()
	timers := newFakeTimers()
	src := newWriteSource(honourCtx, prs...)
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithClock(timers.Now),
		dashboard.WithWriteBudget(writeBudget, timers.After),
	)
	if updating {
		agg.EnableAutoUpdateBranch(&fakeAutoUpdateBranchLister{enabled: map[string]struct{}{"forgejo/o/r": {}}})
	}
	if armed != nil {
		agg.EnableAutoMerge(armedStore(armed...))
	}

	return writeFixture{agg: agg, src: src, timers: timers}
}

// refreshAsync starts a refresh and returns a channel closed when it returns.
func (f writeFixture) refreshAsync(t *testing.T) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.agg.Refresh(t.Context())
	}()

	return done
}

// cutOff runs a refresh whose first write hangs, then passes the budget and
// waits for the refresh to return. It reports which pull request hung.
func (f writeFixture) cutOff(t *testing.T) int {
	t.Helper()
	done := f.refreshAsync(t)
	first := <-f.src.entered
	f.timers.Advance(writeBudget)
	<-done

	return first
}

// nextAttempt runs another refresh and returns the pull request its write
// reached, then lets that refresh finish.
func (f writeFixture) nextAttempt(t *testing.T) int {
	t.Helper()
	done := f.refreshAsync(t)
	got := <-f.src.entered
	f.timers.Advance(writeBudget)
	<-done

	return got
}

// A forge write that hangs must not hold the next refresh. The pass that
// updates behind pull requests gets one budget, then the refresh is done
// with it (#3034).
func TestAggregator_AHungForgeWriteDoesNotHoldTheRefresh(t *testing.T) {
	t.Parallel()

	t.Run("the refresh waits for the budget and not past it", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, false, true, nil, 1)
		var budgetPassed, returnedAfterBudget atomic.Bool
		done := make(chan struct{})
		go func() {
			defer close(done)
			f.agg.Refresh(t.Context())
			returnedAfterBudget.Store(budgetPassed.Load())
		}()
		<-f.src.entered

		f.timers.Advance(writeBudget - time.Second)
		budgetPassed.Store(true)
		f.timers.Advance(time.Second)
		<-done

		assert.True(t, returnedAfterBudget.Load(), "the refresh returned before the budget had passed")
	})

	t.Run("the next refresh publishes while the write still hangs", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, false, true, nil, 1, 2)
		f.cutOff(t)

		f.src.setPRs(2)
		f.agg.Refresh(t.Context())

		assert.Equal(t, []int{2}, numbers(f.agg.Get()), "the pull request closed on the forge leaves the board")
	})

	t.Run("a hung write is not joined by a second one", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, false, true, nil, 1, 2)
		f.cutOff(t)

		f.agg.Refresh(t.Context())

		assert.Equal(t, 1, f.src.callCount(), "only the call that hung was made")
	})

	t.Run("the call that hung is cut off with its context", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, true, nil, 1)
		f.cutOff(t)

		assert.ErrorIs(t, <-f.src.returned, context.Canceled)
	})

	t.Run("a pull request whose update was cut off waits before it is tried again", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, true, nil, 1)
		f.cutOff(t)
		require.Error(t, <-f.src.returned)

		for range 20 {
			f.agg.Refresh(t.Context())
		}

		assert.Equal(t, 1, f.src.callCount())
	})

	t.Run("a pull request the cancelled pass never reached is tried on the next refresh", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, true, nil, 1, 2)
		first := f.cutOff(t)
		require.ErrorIs(t, <-f.src.returned, context.Canceled)

		assert.NotEqual(t, first, f.nextAttempt(t), "the cancelled pass left the other pull request untried")
	})
}

// The auto-merge pass is cut off the same way, and a merge it never made is
// not shown as a refusal.
func TestAggregator_AHungMergeIsCutOffWithoutAFailure(t *testing.T) {
	t.Parallel()

	armed := []string{"forgejo/o/r#1", "forgejo/o/r#2"}

	t.Run("the call that hung is cut off with its context", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, false, armed, 1, 2)
		f.cutOff(t)

		assert.ErrorIs(t, <-f.src.returned, context.Canceled)
	})

	t.Run("no pull request shows a failure for a merge that was cut off", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, false, armed, 1, 2)
		f.cutOff(t)
		require.Error(t, <-f.src.returned)
		f.nextAttempt(t)

		assert.Empty(t, f.agg.AutoMergeReport().Failures)
	})

	t.Run("a pull request the cancelled pass never reached is tried on the next refresh", func(t *testing.T) {
		t.Parallel()
		f := newWriteFixture(t, true, false, armed, 1, 2)
		first := f.cutOff(t)
		require.ErrorIs(t, <-f.src.returned, context.Canceled)

		assert.NotEqual(t, first, f.nextAttempt(t), "the cancelled pass left the other pull request untried")
	})
}

// A scoped refresh's write, the merge a passing check calls for, must not be
// dropped because another pass is running: it waits and then runs.
func TestAggregator_AScopedRefreshWriteWaitsForTheRunningPass(t *testing.T) {
	t.Parallel()

	f := newWriteFixture(t, false, true, []string{"forgejo/o/r#2"}, 1)
	done := f.refreshAsync(t)
	<-f.src.entered
	f.src.setPRs(1, 2)
	require.True(t, f.agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "r", "o/r"))
	f.timers.Advance(writeBudget)
	<-done

	f.src.unblock()
	// The released call succeeded, so the first pull request is updated again
	// before the second one is updated and merged.
	for range 3 {
		<-f.src.entered
	}

	assert.Equal(t, []int{2}, f.src.mergedNumbers())
}

// The pass a scoped refresh queued runs under that refresh's context values,
// so its log lines name the refresh that asked for it, not the pass that was
// in the way.
func TestAggregator_AQueuedPassCarriesTheRefreshThatQueuedIt(t *testing.T) {
	t.Parallel()

	f := newWriteFixture(t, false, true, nil, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		f.agg.Refresh(tagged(t.Context(), "full"))
	}()
	<-f.src.entered
	require.True(t, f.agg.RefreshRepo(tagged(t.Context(), "scoped"), dashboard.ForgeForgejo, "o", "r", "o/r"))
	f.timers.Advance(writeBudget)
	<-done

	f.src.unblock()
	<-f.src.entered

	tags := f.src.callTags()
	require.GreaterOrEqual(t, len(tags), 2)
	assert.Equal(t, "full", tags[0])
	assert.Equal(t, "scoped", tags[1])
}

// Snapshots that pile up behind a running pass are one event, not one warning
// each: the per-snapshot lines are debug, and the pass that ends says once how
// many it kept. Not t.Parallel(): it swaps the global logger.
func TestAggregator_SnapshotsQueuedBehindAPassWarnOnce(t *testing.T) {
	logs := withCapturedLogs(t)

	f := newWriteFixture(t, false, true, nil, 1)
	done := f.refreshAsync(t)
	<-f.src.entered
	for range 3 {
		require.True(t, f.agg.RefreshRepo(t.Context(), dashboard.ForgeForgejo, "o", "r", "o/r"))
	}
	f.timers.Advance(writeBudget)
	<-done
	f.src.unblock()
	<-f.src.entered

	var queued []string
	for line := range strings.SplitSeq(logs.String(), "\n") {
		if strings.Contains(line, "forge writes") && !strings.Contains(line, "past their budget") {
			queued = append(queued, line)
		}
	}
	require.Len(t, queued, 1, "one warning for the whole queue")
	assert.Contains(t, queued[0], "level=WARN")
	assert.Contains(t, queued[0], "queued")
	assert.Contains(t, queued[0], "snapshots=3")
}
