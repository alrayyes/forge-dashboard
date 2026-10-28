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
	limit   *dashboard.RateLimit
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
	res := dashboard.Result{Health: dashboard.ForgeHealth{Forge: s.forge, Reachable: true, RateLimitREST: s.limit}}
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
		refreshUntilServed(t, agg, slow)

		assert.ElementsMatch(t, []int{1, 11}, numbers(agg.Get()))
		assert.Nil(t, health(agg.Get(), dashboard.ForgeForgejo).StaleSince)
	})
}

// refreshUntilServed refreshes until src has answered one. The fetch it hung
// in ends on its own goroutine, so for a moment after its release the
// aggregator still counts it as running and skips the source (#3021).
func refreshUntilServed(t *testing.T, agg *dashboard.Aggregator, src *hangingSource) {
	t.Helper()

	for range 10000 {
		agg.Refresh(t.Context())
		select {
		case <-src.served:
			return
		default:
			runtime.Gosched()
		}
	}
	require.Fail(t, "the source was never asked again")
}

// A refresh a person asked for gives up on a silent forge sooner than the
// schedule does, since someone is waiting on it. The schedule keeps the longer
// deadline (#3021).
func TestAggregator_AManualRefreshWaitsLessThanTheSchedule(t *testing.T) {
	t.Parallel()

	const (
		deadline     = 3 * time.Minute
		userDeadline = time.Minute
	)

	// start returns an aggregator whose second forge hangs, with a refresh
	// under ctx running against it.
	start := func(t *testing.T, ctx func(context.Context) context.Context) (*fakeTimers, <-chan struct{}, *hangingSource) {
		t.Helper()
		timers := newFakeTimers()
		slow := newHangingSource(dashboard.ForgeForgejo, 10)
		agg := dashboard.NewAggregator(
			[]dashboard.Source{slow},
			dashboard.WithClock(timers.Now),
			dashboard.WithFetchDeadline(deadline, timers.After),
			dashboard.WithUserFetchDeadline(userDeadline),
		)
		agg.Refresh(t.Context())
		<-slow.served
		slow.setHang(true)
		done := make(chan struct{})
		go func() {
			defer close(done)
			agg.Refresh(ctx(t.Context()))
		}()
		<-slow.entered

		return timers, done, slow
	}

	t.Run("a manual refresh publishes at the user deadline", func(t *testing.T) {
		t.Parallel()
		timers, done, slow := start(t, func(c context.Context) context.Context { return c })
		timers.Advance(userDeadline)
		<-done
		close(slow.release)
	})

	t.Run("a scheduled refresh is still waiting at the user deadline", func(t *testing.T) {
		t.Parallel()
		timers, done, slow := start(t, dashboard.BackgroundForTest)
		timers.Advance(userDeadline)

		select {
		case <-done:
			require.Fail(t, "the scheduled refresh gave up at the user deadline")
		default:
		}
		timers.Advance(deadline - userDeadline)
		<-done
		close(slow.release)
	})
}

// A click that joins a scheduled run already in flight is still the person's
// refresh: it waits the user deadline, counted from when the run began, not the
// schedule's (#3021).
func TestAggregator_AManualRefreshJoiningAScheduledRunWaitsLessThanTheSchedule(t *testing.T) {
	t.Parallel()

	const (
		deadline     = 3 * time.Minute
		userDeadline = time.Minute
	)

	// settle yields until cond holds, within a bound.
	settle := func(cond func() bool) bool {
		for range 10000 {
			if cond() {
				return true
			}
			runtime.Gosched()
		}

		return cond()
	}
	finished := func(done <-chan struct{}) func() bool {
		return func() bool {
			select {
			case <-done:
				return true
			default:
				return false
			}
		}
	}

	setup := func(t *testing.T) (*fakeTimers, *hangingSource, <-chan struct{}, <-chan struct{}) {
		t.Helper()
		timers := newFakeTimers()
		slow := newHangingSource(dashboard.ForgeForgejo, 10)
		agg := dashboard.NewAggregator(
			[]dashboard.Source{slow},
			dashboard.WithClock(timers.Now),
			dashboard.WithFetchDeadline(deadline, timers.After),
			dashboard.WithUserFetchDeadline(userDeadline),
		)
		agg.Refresh(t.Context())
		<-slow.served
		slow.setHang(true)

		scheduled := make(chan struct{})
		go func() {
			defer close(scheduled)
			agg.Refresh(dashboard.BackgroundForTest(t.Context()))
		}()
		<-slow.entered

		// The click arrives a little into the run.
		timers.AdvanceWithoutWaiting(10 * time.Second)
		manual := make(chan struct{})
		go func() {
			defer close(manual)
			agg.Refresh(t.Context())
		}()
		settle(func() bool { return timers.Pending() >= 2 })

		return timers, slow, scheduled, manual
	}

	t.Run("the click publishes at the user deadline", func(t *testing.T) {
		t.Parallel()
		timers, slow, _, manual := setup(t)
		timers.Advance(userDeadline - 10*time.Second)

		assert.True(t, settle(finished(manual)))
		close(slow.release)
	})

	t.Run("the run ends with it", func(t *testing.T) {
		t.Parallel()
		timers, slow, scheduled, _ := setup(t)
		timers.Advance(userDeadline - 10*time.Second)

		assert.True(t, settle(finished(scheduled)))
		close(slow.release)
	})
}

// A forge whose last fetch is still running is not asked again: a second
// fetch on top of a stuck one only adds load to a forge that is struggling.
// Its rows stay, marked stale, until the fetch ends (#3021).
func TestAggregator_ASourceStillFetchingIsNotAskedAgain(t *testing.T) {
	t.Parallel()

	const userDeadline = time.Minute

	setup := func(t *testing.T) (*dashboard.Aggregator, *hangingSource, *hangingSource) {
		t.Helper()
		timers := newFakeTimers()
		fast := newHangingSource(dashboard.ForgeGitHub, 1)
		slow := newHangingSource(dashboard.ForgeForgejo, 10)
		slow.limit = &dashboard.RateLimit{Limit: 5000, Remaining: 4000}
		agg := dashboard.NewAggregator(
			[]dashboard.Source{fast, slow},
			dashboard.WithClock(timers.Now),
			dashboard.WithUserFetchDeadline(userDeadline),
			dashboard.WithFetchDeadline(3*userDeadline, timers.After),
		)
		agg.Refresh(t.Context())
		<-fast.served
		<-slow.served

		// The first refresh hangs on slow and gives up at the deadline.
		slow.setHang(true)
		first := make(chan struct{})
		go func() {
			defer close(first)
			agg.Refresh(t.Context())
		}()
		<-slow.entered
		<-fast.served
		for range 100 {
			runtime.Gosched()
		}
		timers.Advance(userDeadline)
		<-first

		return agg, fast, slow
	}

	// second runs a refresh while slow's first fetch is still stuck, and
	// reports whether it asked slow again.
	second := func(t *testing.T, agg *dashboard.Aggregator, slow *hangingSource) (askedAgain bool) {
		t.Helper()
		done := make(chan struct{})
		go func() {
			defer close(done)
			agg.Refresh(t.Context())
		}()
		select {
		case <-done:
			return false
		case <-slow.entered:
			return true
		}
	}

	t.Run("the refresh does not call it again", func(t *testing.T) {
		t.Parallel()
		agg, _, slow := setup(t)

		assert.False(t, second(t, agg, slow))
		close(slow.release)
	})

	t.Run("its rows stay, marked stale", func(t *testing.T) {
		t.Parallel()
		agg, _, slow := setup(t)
		second(t, agg, slow)

		h := health(agg.Get(), dashboard.ForgeForgejo)
		assert.Contains(t, numbers(agg.Get()), 10)
		assert.False(t, h.Reachable)
		assert.Equal(t, dashboard.ForgeErrorUnreachable, h.ErrorKind)
		assert.NotNil(t, h.StaleSince)
		close(slow.release)
	})

	t.Run("its rate limits stay", func(t *testing.T) {
		t.Parallel()
		agg, _, slow := setup(t)
		second(t, agg, slow)

		require.NotNil(t, health(agg.Get(), dashboard.ForgeForgejo).RateLimitREST)
		assert.Equal(t, 4000, health(agg.Get(), dashboard.ForgeForgejo).RateLimitREST.Remaining)
		close(slow.release)
	})

	t.Run("the others are still fetched", func(t *testing.T) {
		t.Parallel()
		agg, fast, slow := setup(t)
		fast.setHang(false, 2)
		second(t, agg, slow)

		assert.ElementsMatch(t, []int{2, 10}, numbers(agg.Get()))
		close(slow.release)
	})

	t.Run("it is asked again once the fetch has ended", func(t *testing.T) {
		t.Parallel()
		agg, _, slow := setup(t)
		close(slow.release)
		slow.setHang(false, 11)
		refreshUntilServed(t, agg, slow)

		assert.Contains(t, numbers(agg.Get()), 11)
	})
}
