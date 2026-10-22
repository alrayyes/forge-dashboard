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

func forceRefreshFixture(t *testing.T, cooldown time.Duration) (*dashboard.Service, *countingSource) {
	t.Helper()

	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	m.SetForceRefreshCooldown(cooldown)
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, m.FirstRefreshDone, time.Second, 5*time.Millisecond)

	return m, src
}

func TestService_ForceRefresh_FirstCall_FetchesWithoutThrottling(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)

	retryAfter, ok := m.ForceRefresh(t.Context())

	assert.True(t, ok)
	assert.Zero(t, retryAfter)
	assert.Equal(t, int32(2), src.calls.Load())
}

func TestService_ForceRefresh_InsideTheCooldown_DoesNotFetch(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context())

	retryAfter, ok := m.ForceRefresh(t.Context())

	assert.True(t, ok)
	assert.Positive(t, retryAfter)
	assert.LessOrEqual(t, retryAfter, time.Minute)
	assert.Equal(t, int32(2), src.calls.Load(), "only the first force refresh fetched")
}

func TestService_ForceRefresh_AfterTheCooldown_FetchesAgain(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, 20*time.Millisecond)
	m.ForceRefresh(t.Context())
	time.Sleep(40 * time.Millisecond)

	retryAfter, _ := m.ForceRefresh(t.Context())

	assert.Zero(t, retryAfter)
	assert.Equal(t, int32(3), src.calls.Load())
}

func TestService_ForceRefresh_NothingRunning_ReportsNotOK(t *testing.T) {
	t.Parallel()

	m := dashboard.NewService(time.Minute)
	t.Cleanup(m.Stop)

	_, ok := m.ForceRefresh(t.Context())

	assert.False(t, ok)
}

func TestService_RefreshNow_IsNotThrottledByTheCooldown(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context())

	m.RefreshNow(t.Context())

	assert.Equal(t, int32(3), src.calls.Load(), "a webhook's refresh still fetches")
}

func TestService_Stop_KeepsTheForceRefreshCooldown(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context())
	m.Stop()
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, m.FirstRefreshDone, time.Second, 5*time.Millisecond)

	retryAfter, ok := m.ForceRefresh(t.Context())

	assert.True(t, ok)
	assert.Positive(t, retryAfter, "halting the loop must not hand out a free refresh")
}

func TestService_Reset_ClearsTheForceRefreshCooldown(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context())
	m.Stop()
	m.Reset()
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, m.FirstRefreshDone, time.Second, 5*time.Millisecond)

	retryAfter, ok := m.ForceRefresh(t.Context())

	assert.True(t, ok)
	assert.Zero(t, retryAfter, "a reset Service starts like a fresh process")
}

func TestService_Ensure_KeepsTheForceRefreshCooldown(t *testing.T) {
	t.Parallel()

	m, src := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context())
	m.Ensure(t.Context(), []dashboard.Source{src})

	retryAfter, _ := m.ForceRefresh(t.Context())

	assert.Positive(t, retryAfter, "a settings save doesn't dodge the throttle")
}

// firstGateSource holds its fetch until release is closed, so a test can ask for a
// refresh while the first one is still running.
type firstGateSource struct {
	calls   atomic.Int32
	release chan struct{}
}

func (s *firstGateSource) Fetch(_ context.Context) dashboard.Result {
	s.calls.Add(1)
	<-s.release

	return dashboard.Result{Health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
}

func (s *firstGateSource) Forge() dashboard.Forge { return dashboard.ForgeGitHub }

func TestService_ForceRefresh_DuringTheFirstRefresh_AnswersAtOnceWithoutFetching(t *testing.T) {
	t.Parallel()

	src := &firstGateSource{release: make(chan struct{})}
	m := dashboard.NewService(time.Hour)
	t.Cleanup(m.Stop)
	t.Cleanup(func() { close(src.release) })
	m.Ensure(t.Context(), []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	type answer struct {
		retryAfter time.Duration
		ok         bool
	}
	got := make(chan answer, 1)
	go func() {
		retryAfter, ok := m.ForceRefresh(t.Context())
		got <- answer{retryAfter, ok}
	}()

	select {
	case a := <-got:
		assert.True(t, a.ok)
		assert.Positive(t, a.retryAfter)
		assert.Equal(t, int32(1), src.calls.Load(), "no second fetch")
	case <-time.After(time.Second):
		t.Fatal("ForceRefresh waited for the first refresh")
	}
}
