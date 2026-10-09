package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func forceRefreshFixture(t *testing.T, cooldown time.Duration) (*dashboard.Manager, *countingSource, []byte) {
	t.Helper()

	user := []byte("user-a")
	src := &countingSource{health: dashboard.ForgeHealth{Forge: dashboard.ForgeGitHub, Reachable: true}}
	m := dashboard.NewManager(time.Hour)
	t.Cleanup(m.Stop)
	m.SetForceRefreshCooldown(cooldown)
	m.Ensure(t.Context(), user, []dashboard.Source{src})
	require.Eventually(t, func() bool { return src.calls.Load() >= 1 }, time.Second, 5*time.Millisecond)

	return m, src, user
}

func TestManager_ForceRefresh_FirstCall_FetchesWithoutThrottling(t *testing.T) {
	t.Parallel()

	m, src, user := forceRefreshFixture(t, time.Minute)

	retryAfter, ok := m.ForceRefresh(t.Context(), user)

	assert.True(t, ok)
	assert.Zero(t, retryAfter)
	assert.Equal(t, int32(2), src.calls.Load())
}

func TestManager_ForceRefresh_InsideTheCooldown_DoesNotFetch(t *testing.T) {
	t.Parallel()

	m, src, user := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context(), user)

	retryAfter, ok := m.ForceRefresh(t.Context(), user)

	assert.True(t, ok)
	assert.Positive(t, retryAfter)
	assert.LessOrEqual(t, retryAfter, time.Minute)
	assert.Equal(t, int32(2), src.calls.Load(), "only the first force refresh fetched")
}

func TestManager_ForceRefresh_AfterTheCooldown_FetchesAgain(t *testing.T) {
	t.Parallel()

	m, src, user := forceRefreshFixture(t, 20*time.Millisecond)
	m.ForceRefresh(t.Context(), user)
	time.Sleep(40 * time.Millisecond)

	retryAfter, _ := m.ForceRefresh(t.Context(), user)

	assert.Zero(t, retryAfter)
	assert.Equal(t, int32(3), src.calls.Load())
}

func TestManager_ForceRefresh_UnknownUser_ReportsNotOK(t *testing.T) {
	t.Parallel()

	m := dashboard.NewManager(time.Minute)
	t.Cleanup(m.Stop)

	_, ok := m.ForceRefresh(t.Context(), []byte("nobody"))

	assert.False(t, ok)
}

func TestManager_RefreshNow_IsNotThrottledByTheCooldown(t *testing.T) {
	t.Parallel()

	m, src, user := forceRefreshFixture(t, time.Minute)
	m.ForceRefresh(t.Context(), user)

	m.RefreshNow(t.Context(), user)

	assert.Equal(t, int32(3), src.calls.Load(), "a webhook's refresh still fetches")
}
