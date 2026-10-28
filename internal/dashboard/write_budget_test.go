package dashboard_test

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// writeSource is a Forgejo source whose pull requests are all behind, and
// whose branch update hangs until release is closed. With honourCtx it also
// ends when its context does, the way a real HTTP call does; without it, it
// ignores the context, the worst a stuck forge can do.
type writeSource struct {
	mu         sync.Mutex
	prs        []int
	calls      []int
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

func (s *writeSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	prs := append([]int(nil), s.prs...)
	s.mu.Unlock()

	res := dashboard.Result{
		Health: dashboard.ForgeHealth{Forge: dashboard.ForgeForgejo, Reachable: true},
		Repos:  []dashboard.Repo{{Forge: dashboard.ForgeForgejo, FullName: "o/r"}},
	}
	for _, n := range prs {
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: dashboard.ForgeForgejo, Repo: "o/r", Number: n, Behind: true})
	}

	return res
}

func (s *writeSource) UpdateBranch(ctx context.Context, _, _ string, number int) (bool, error) {
	s.mu.Lock()
	s.calls = append(s.calls, number)
	s.mu.Unlock()
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
		return false, fmt.Errorf("update branch: %w", err)
	}

	return false, nil
}

// A forge write that hangs must not hold the next refresh. The pass that
// updates behind pull requests gets one budget, then the refresh is done
// with it (#3034).
func TestAggregator_AHungForgeWriteDoesNotHoldTheRefresh(t *testing.T) {
	t.Parallel()

	const budget = time.Minute

	setup := func(t *testing.T, honourCtx bool, prs ...int) (*dashboard.Aggregator, *writeSource, *fakeTimers) {
		t.Helper()
		timers := newFakeTimers()
		src := newWriteSource(honourCtx, prs...)
		t.Cleanup(src.unblock)
		agg := dashboard.NewAggregator(
			[]dashboard.Source{src},
			dashboard.WithClock(timers.Now),
			dashboard.WithWriteBudget(budget, timers.After),
		)
		agg.EnableAutoUpdateBranch(&fakeAutoUpdateBranchLister{enabled: map[string]struct{}{"forgejo/o/r": {}}})

		return agg, src, timers
	}

	// refreshAsync starts a refresh and returns a channel closed when it returns.
	refreshAsync := func(t *testing.T, agg *dashboard.Aggregator) <-chan struct{} {
		t.Helper()
		done := make(chan struct{})
		go func() {
			defer close(done)
			agg.Refresh(t.Context())
		}()

		return done
	}

	t.Run("the refresh returns once the budget has passed", func(t *testing.T) {
		t.Parallel()
		agg, src, timers := setup(t, false, 1)
		done := refreshAsync(t, agg)
		<-src.entered

		select {
		case <-done:
			require.Fail(t, "the refresh returned before the budget, with its write still hanging")
		default:
		}
		timers.Advance(budget)
		<-done
	})

	t.Run("the next refresh publishes while the write still hangs", func(t *testing.T) {
		t.Parallel()
		agg, src, timers := setup(t, false, 1, 2)
		done := refreshAsync(t, agg)
		<-src.entered
		timers.Advance(budget)
		<-done

		src.setPRs(2)
		agg.Refresh(t.Context())

		assert.Equal(t, []int{2}, numbers(agg.Get()), "the pull request closed on the forge leaves the board")
	})

	t.Run("a hung write is not joined by a second one", func(t *testing.T) {
		t.Parallel()
		agg, src, timers := setup(t, false, 1, 2)
		done := refreshAsync(t, agg)
		<-src.entered
		timers.Advance(budget)
		<-done

		agg.Refresh(t.Context())

		assert.Equal(t, 1, src.callCount(), "only the call that hung was made")
	})

	t.Run("the call that hung is cut off with its context", func(t *testing.T) {
		t.Parallel()
		agg, src, timers := setup(t, true, 1)
		done := refreshAsync(t, agg)
		<-src.entered
		timers.Advance(budget)
		<-done

		assert.ErrorIs(t, <-src.returned, context.Canceled)
	})

	t.Run("a pull request whose update was cut off waits before it is tried again", func(t *testing.T) {
		t.Parallel()
		agg, src, timers := setup(t, true, 1)
		done := refreshAsync(t, agg)
		<-src.entered
		timers.Advance(budget)
		<-done
		require.ErrorIs(t, <-src.returned, context.Canceled)

		for range 20 {
			agg.Refresh(t.Context())
		}

		assert.Equal(t, 1, src.callCount())
	})
}
