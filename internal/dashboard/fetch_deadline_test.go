package dashboard_test

import (
	"context"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// hangingSource serves one forge and can be told to hang: its fetch then
// blocks until release is closed, ignoring its context, the way a forge that
// stopped answering does.
type hangingSource struct {
	forge   dashboard.Forge
	mu      sync.Mutex
	prs     []int
	hang    bool
	entered chan struct{}
	release chan struct{}
	served  chan struct{}
}

func newHangingSource(forge dashboard.Forge, prs ...int) *hangingSource {
	return &hangingSource{forge: forge, prs: prs, entered: make(chan struct{}, 4), release: make(chan struct{}), served: make(chan struct{}, 8)}
}

func (s *hangingSource) Forge() dashboard.Forge { return s.forge }

func (s *hangingSource) setHang(hang bool, prs ...int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hang = hang
	if prs != nil {
		s.prs = prs
	}
}

func (s *hangingSource) Fetch(context.Context) dashboard.Result {
	s.mu.Lock()
	hang, prs := s.hang, s.prs
	s.mu.Unlock()
	if hang {
		s.entered <- struct{}{}
		<-s.release

		return dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true}}
	}
	defer func() { s.served <- struct{}{} }()
	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true}}
	for _, n := range prs {
		res.PullRequests = append(res.PullRequests, dashboard.PullRequest{Forge: s.forge, Repo: "o/r", Number: n})
	}
	res.Repos = []dashboard.Repo{{Forge: s.forge, FullName: "o/r"}}

	return res
}

// A forge that hangs does not hold back the others: the refresh publishes
// when the fetch deadline passes, with the slow forge's last rows kept and
// marked stale (#3019).
func TestAggregator_AHungForgeDoesNotHoldBackTheOthers(t *testing.T) {
	t.Parallel()

	const deadline = 3 * time.Minute

	setup := func(t *testing.T) (*dashboard.Aggregator, *hangingSource, *hangingSource, *fakeTimers) {
		t.Helper()
		timers := newFakeTimers()
		fast := newHangingSource(dashboard.ForgeGitHub, 1)
		slow := newHangingSource(dashboard.ForgeForgejo, 10)
		agg := dashboard.NewAggregator(
			[]dashboard.Source{fast, slow},
			dashboard.WithClock(timers.Now),
			dashboard.WithFetchDeadline(deadline, timers.After),
		)
		agg.Refresh(t.Context())
		<-fast.served
		<-slow.served

		return agg, fast, slow, timers
	}

	// refreshHung starts a refresh while slow hangs, waits until slow is
	// stuck, and returns a channel closed when the refresh returns.
	refreshHung := func(t *testing.T, agg *dashboard.Aggregator, fast, slow *hangingSource) <-chan struct{} {
		t.Helper()
		slow.setHang(true)
		done := make(chan struct{})
		go func() {
			defer close(done)
			agg.Refresh(t.Context())
		}()
		<-slow.entered
		<-fast.served
		// Let the fast forge's answer reach the refresh before the deadline.
		for range 100 {
			runtime.Gosched()
		}

		return done
	}

	t.Run("publishes at the deadline instead of waiting for it", func(t *testing.T) {
		t.Parallel()
		agg, fast, slow, timers := setup(t)
		fast.setHang(false, 2)
		done := refreshHung(t, agg, fast, slow)

		select {
		case <-done:
			require.Fail(t, "the refresh returned before the deadline")
		default:
		}
		timers.Advance(deadline)
		<-done

		assert.ElementsMatch(t, []int{2, 10}, numbers(agg.Get()), "the fast forge is fresh, the slow one kept")
		close(slow.release)
	})

	t.Run("the slow forge keeps its rows, marked stale and timed out", func(t *testing.T) {
		t.Parallel()
		agg, fast, slow, timers := setup(t)
		done := refreshHung(t, agg, fast, slow)
		timers.Advance(deadline)
		<-done

		h := health(agg.Get(), dashboard.ForgeForgejo)
		assert.False(t, h.Reachable)
		assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
		assert.NotEmpty(t, h.Error)
		require.NotNil(t, h.StaleSince, "says when the rows shown were fetched")
		assert.True(t, health(agg.Get(), dashboard.ForgeGitHub).Reachable, "the fast forge is untouched")
		close(slow.release)
	})

	t.Run("the slow forge's rows are replaced once it answers", func(t *testing.T) {
		t.Parallel()
		agg, fast, slow, timers := setup(t)
		done := refreshHung(t, agg, fast, slow)
		timers.Advance(deadline)
		<-done
		close(slow.release)

		slow.setHang(false, 11)
		agg.Refresh(t.Context())

		assert.ElementsMatch(t, []int{1, 11}, numbers(agg.Get()))
		assert.Nil(t, health(agg.Get(), dashboard.ForgeForgejo).StaleSince)
	})
}
