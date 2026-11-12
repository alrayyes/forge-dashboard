package api_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/api"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	settingspkg "github.com/alrayyes/forge-dashboard/internal/settings"
	"github.com/stretchr/testify/assert"
)

func recentlyStartedFor(t *testing.T, startedAt time.Time) any {
	t.Helper()

	srv, _, _, _ := newTestServerWithSettingsStore(t, func(settingspkg.Credentials) []dashboard.Source { return nil },
		false, 0, func(d *api.Deps) { d.StartedAt = startedAt })
	cookie, _, _ := registerViaRealCeremony(t, srv)

	return fetchDashboardWith(t, srv.URL, cookie, "")["recentlyStarted"]
}

// A page that sees a forge fail right after a restart can't tell an outage
// from the first refresh still running. The server says which (#3554).
func TestDashboard_RecentlyStarted_TrueWithinFiveMinutesOfStart(t *testing.T) {
	t.Parallel()

	assert.Equal(t, true, recentlyStartedFor(t, time.Now().Add(-4*time.Minute)))
}

func TestDashboard_RecentlyStarted_FalseAfterFiveMinutes(t *testing.T) {
	t.Parallel()

	assert.Equal(t, false, recentlyStartedFor(t, time.Now().Add(-6*time.Minute)))
}

func TestDashboard_RecentlyStarted_FalseWhenTheStartTimeIsUnknown(t *testing.T) {
	t.Parallel()

	assert.Equal(t, false, recentlyStartedFor(t, time.Time{}))
}
