package dashboard_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// A restored forge still starting up has not failed a refresh, so the deadline
// pass logs no "full refresh failed" line with an empty cause. Not parallel:
// the default logger is global.
func TestAggregator_AHungFirstFetchIsNotLoggedAsAFailedRefresh(t *testing.T) {
	logs := captureLogs(t)

	const deadline = time.Minute

	timers := newFakeTimers()
	src := newHangingSource(dashboard.ForgeGitHub, 1)
	t.Cleanup(src.unblock)
	agg := dashboard.NewAggregator(
		[]dashboard.Source{src},
		dashboard.WithSnapshotCache(savedByAFirstRun(t)),
		dashboard.WithClock(timers.Now),
		dashboard.WithFetchDeadline(deadline, timers.After),
		dashboard.WithUserFetchDeadline(deadline),
	)

	missOnce(t, agg, src, timers)

	assert.Contains(t, logs.String(), "fetch deadline passed")
	assert.NotContains(t, logs.String(), "full refresh failed")
}
