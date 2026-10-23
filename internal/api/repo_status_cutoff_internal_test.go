package api

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

// The flag turns on exactly at the cutoff, three refresh intervals after the
// first failure, judged against the one clock the whole payload is built with.
func TestRepoStatuses_FailingForGoodAtTheCutoff(t *testing.T) {
	t.Parallel()

	interval := time.Minute
	now := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	board := boardSettings{refreshInterval: interval, now: now}
	repoAt := func(age time.Duration) dashboard.Repo {
		since := now.Add(-age)

		return dashboard.Repo{Forge: dashboard.ForgeGitHub, FullName: "o/r", StaleSince: &since, FailingSince: &since}
	}

	just := board.repoStatuses([]dashboard.Repo{repoAt(3*interval - time.Nanosecond)})[0]
	assert.NotNil(t, just.FailingSince)
	assert.False(t, just.FailingForGood)

	at := board.repoStatuses([]dashboard.Repo{repoAt(3 * interval)})[0]
	assert.True(t, at.FailingForGood)
}
