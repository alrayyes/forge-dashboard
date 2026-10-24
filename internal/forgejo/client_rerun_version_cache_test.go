package forgejo_test

import (
	"context"
	"sync"
	"testing"
	"time"

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

	assert.Equal(t, []string{"/api/v1/repos/alrayyes/a/actions/runs/42/rerun"}, s.posts)
}

// The click runs under the caller's context, not a timer of its own.
func TestRerunFailedChecks_StopsWaitingForTheVersionWhenTheCallerGivesUp(t *testing.T) {
	t.Parallel()
	s := &versionServer{version: "17.0.0+gitea-1.22.0", hang: make(chan struct{})}
	c := s.start(t)
	ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
	defer cancel()

	start := time.Now()
	_ = c.RerunFailedChecks(ctx, "alrayyes", "a", 5)

	assert.Less(t, time.Since(start), 2*time.Second)
	close(s.hang)
}
