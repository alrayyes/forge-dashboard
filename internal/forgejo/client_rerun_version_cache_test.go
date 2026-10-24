package forgejo_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// settled is what the dashboard sees after a refresh has started the version
// read and it has finished: the first ask only starts the read.
func settled(c *forgejo.Client) string {
	_ = c.RerunChecksBlockedReason()
	forgejo.WaitForVersionProbe(c)

	return c.RerunChecksBlockedReason()
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)}
}

func (f *fakeClock) now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.t
}

func (f *fakeClock) advance(d time.Duration) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.t = f.t.Add(d)
}

// A refresh asks every few seconds; a slow Forgejo must not slow it down.
func TestRerunChecksBlockedReason_DoesNotWaitForTheVersionRead(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)

	done := make(chan string, 1)
	go func() { done <- c.RerunChecksBlockedReason() }()

	select {
	case reason := <-done:
		assert.Empty(t, reason)
	case <-time.After(time.Second):
		t.Fatal("the refresh path waited on the version read")
	}
	close(s.hang)
	forgejo.WaitForVersionProbe(c)
}

// A refusal that was true on 16 is not kept after the instance upgrades.
func TestRerunChecksBlockedReason_ABlockedAnswerExpires(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	require.Equal(t, noRerunReason, settled(c))

	s.setVersion("17.0.0+gitea-1.22.0")
	clock.advance(2 * time.Hour)

	assert.Empty(t, settled(c))
}

func TestRerunChecksBlockedReason_ASeventeenAnswerIsKept(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0"}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	_ = settled(c)

	clock.advance(48 * time.Hour)
	_ = settled(c)

	assert.Equal(t, 1, s.readCount())
}

// A read that failed is tried again, but not on every refresh.
func TestRerunChecksBlockedReason_AFailedReadIsNotRepeatedAtOnce(t *testing.T) {
	t.Parallel()
	s := &versionServer{}
	c := s.start(t)
	forgejo.SetVersionClock(c, newClock().now)

	_ = settled(c)
	_ = settled(c)

	assert.Equal(t, 1, s.readCount())
}

func TestRerunChecksBlockedReason_AFailedReadIsRetriedLater(t *testing.T) {
	t.Parallel()
	s := &versionServer{}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	require.Empty(t, settled(c))

	s.setVersion("16.0.6+gitea-1.22.0")
	clock.advance(time.Minute)

	assert.Equal(t, noRerunReason, settled(c))
}

// A version that doesn't parse says nothing about the instance, so it is
// read again like a failed read, not trusted for good.
func TestRerunChecksBlockedReason_AVersionInWordsIsReadAgainLater(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "nightly"}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	require.Empty(t, settled(c))

	s.setVersion("16.0.6+gitea-1.22.0")
	clock.advance(time.Minute)

	assert.Equal(t, noRerunReason, settled(c))
}

// When the hour is up and the forge can't be asked, the old "older than 17"
// answer is not served on trust: the rerun is left to the forge.
func TestRerunChecksBlockedReason_AStaleBlockIsLiftedWhenTheReReadFails(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	require.Equal(t, noRerunReason, settled(c))

	s.setVersion("")
	clock.advance(2 * time.Hour)

	assert.Empty(t, settled(c))
}

func TestRerunChecksBlockedReason_ManyCallersReadTheVersionOnce(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0"}
	c := s.start(t)

	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() { _ = c.RerunChecksBlockedReason() })
	}
	wg.Wait()
	forgejo.WaitForVersionProbe(c)

	assert.Equal(t, 1, s.readCount())
}

// The click asks the forge again when its answer has gone stale, so an
// upgraded instance works without waiting for the next refresh.
func TestRerunFailedChecks_AfterAnUpgrade_PostsWithoutARefresh(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0"}
	c := s.start(t)
	clock := newClock()
	forgejo.SetVersionClock(c, clock.now)
	require.Equal(t, noRerunReason, settled(c))
	s.setVersion("17.0.0+gitea-1.22.0")
	clock.advance(2 * time.Hour)

	require.NoError(t, c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5))

	assert.Equal(t, []string{"142"}, s.rerunsSeen())
}

// The click runs under the caller's context, not a timer of its own: when
// that ends during the click's own read, the click is told so.
func TestRerunFailedChecks_StopsWaitingForTheVersionWhenTheCallerGivesUp(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)
	defer close(s.hang)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.RerunFailedChecks(ctx, "alrayyes", "a", 5) }()
	require.Eventually(t, func() bool { return s.readCount() == 1 }, 5*time.Second, time.Millisecond)

	cancel()

	assert.ErrorIs(t, recv(t, done), context.Canceled)
}

// A read that panics (net/http recovers a handler's panic, but nothing recovers
// the caller's) must still close the flight, or later clicks wait on a read
// that is never coming. The panic comes from the transport, which runs in the
// click's own goroutine.
func TestRerunFailedChecks_AVersionReadThatPanicsDoesNotWedgeLaterClicks(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0"}
	c := s.start(t)
	var panicked atomic.Bool
	forgejo.WrapTransport(c, func(next http.RoundTripper) http.RoundTripper {
		return roundTripperFunc(func(r *http.Request) (*http.Response, error) {
			if strings.HasSuffix(r.URL.Path, "/version") && panicked.CompareAndSwap(false, true) {
				panic("transport failed")
			}

			return next.RoundTrip(r)
		})
	})
	func() {
		defer func() { _ = recover() }()
		_ = c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5)
	}()
	require.True(t, panicked.Load(), "the read never reached the transport")

	assert.False(t, forgejo.VersionReadOpen(c), "the flight is still open")
	assert.NoError(t, c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5))
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A click that gives up while another read is under way is told so, as a forge
// that did not answer; it does not go on as if the version were unknown.
func TestRerunFailedChecks_AWaiterThatGivesUpGetsAnUnreachableForgeError(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)
	defer close(s.hang)
	parked := make(chan struct{}, 1)
	forgejo.SetVersionParkHook(c, func() { parked <- struct{}{} })
	leaderCtx, stopLeader := context.WithCancel(t.Context())
	defer stopLeader()
	go func() { _ = c.RerunFailedChecks(leaderCtx, "alrayyes", "a", 5) }()
	require.Eventually(t, func() bool { return s.readCount() == 1 }, 5*time.Second, time.Millisecond)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- c.RerunFailedChecks(ctx, "alrayyes", "a", 5) }()
	recv(t, parked)

	cancel()

	err := recv(t, done)
	require.ErrorIs(t, err, context.Canceled)
	clientErr, ok := errors.AsType[*dashboard.ClientError](err)
	require.True(t, ok, "want a ClientError, got %v", err)
	assert.Equal(t, dashboard.ForgeErrorUnreachable, clientErr.Kind)
	got := dashboard.ClassifyActionRefusalFor(dashboard.PullRequestActionRerunChecks, err, nil)
	assert.Equal(t, "The forge didn't answer. Try again in a moment.", got.Message)
}

// A waiter woken by a read its own click cancelled finds nothing new, so it
// reads the version itself instead of deciding on the stale cache.
func TestRerunFailedChecks_AWaiterWokenByACancelledRead_ReadsTheVersionItself(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "16.0.6+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)
	parked := make(chan struct{}, 1)
	forgejo.SetVersionParkHook(c, func() { parked <- struct{}{} })
	leaderCtx, cancelLeader := context.WithCancel(t.Context())
	defer cancelLeader()
	leaderDone := make(chan error, 1)
	go func() { leaderDone <- c.RerunFailedChecks(leaderCtx, "alrayyes", "a", 5) }()
	require.Eventually(t, func() bool { return s.readCount() == 1 }, 5*time.Second, time.Millisecond)
	waiterDone := make(chan error, 1)
	go func() { waiterDone <- c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5) }()
	recv(t, parked)

	cancelLeader()
	require.ErrorIs(t, recv(t, leaderDone), context.Canceled)
	close(s.hang)

	assert.Equal(t, noRerunReason, dashboard.ForgeMessage(recv(t, waiterDone)))
	assert.Equal(t, 2, s.readCount())
}

// A read can land between a click seeing the answer stale and joining: the
// click then finds it fresh under the lock and neither reads nor waits.
func TestVersionJoin_AReadThatLandedSinceTheStaleCheck_NeitherLeadsNorWaits(t *testing.T) {
	t.Parallel()
	c := (&versionServer{version: "17.0.0+gitea-1.22.0"}).start(t)
	require.False(t, forgejo.VersionAnswerFresh(c), "nothing has been read yet")

	forgejo.RecordVersion(c, 17, true)
	wait, lead := forgejo.JoinVersionRead(c)

	assert.False(t, lead)
	assert.Nil(t, wait)
	assert.False(t, forgejo.VersionReadOpen(c))
}

// Click waiters woken by a read their leader cancelled do not read one after
// another: one of them takes over and the rest wait on its read.
func TestRerunFailedChecks_WaitersWokenByACancelledRead_ShareOneNewRead(t *testing.T) {
	t.Parallel()
	const waiters = 3
	s := &versionServer{version: "16.0.6+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)
	parked := make(chan struct{}, 4*waiters)
	forgejo.SetVersionParkHook(c, func() { parked <- struct{}{} })
	leaderCtx, cancelLeader := context.WithCancel(t.Context())
	defer cancelLeader()
	leaderDone := make(chan error, 1)
	go func() { leaderDone <- c.RerunFailedChecks(leaderCtx, "alrayyes", "a", 5) }()
	require.Eventually(t, func() bool { return s.readCount() == 1 }, 5*time.Second, time.Millisecond)
	waiterDone := make(chan error, waiters)
	for range waiters {
		go func() { waiterDone <- c.RerunFailedChecks(t.Context(), "alrayyes", "a", 5) }()
	}
	for range waiters {
		recv(t, parked)
	}

	cancelLeader()
	require.ErrorIs(t, recv(t, leaderDone), context.Canceled)
	require.Eventually(t, func() bool { return s.readCount() == 2 }, 5*time.Second, time.Millisecond)
	close(s.hang)

	for range waiters {
		assert.Equal(t, noRerunReason, dashboard.ForgeMessage(recv(t, waiterDone)))
	}
	assert.Equal(t, 2, s.readCount())
}
