package dashboard_test

import (
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
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

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

func TestService_ForceRefresh_UnknownUser_ReportsNotOK(t *testing.T) {
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
