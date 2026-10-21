package dashboard

import "time"

const (
	// stretchFactor is how many times longer the full refresh waits while
	// every tracked repo has a healthy webhook.
	stretchFactor = 4
	// maxStretchedInterval caps the stretch. A configured interval already past
	// it is kept as it is: the stretch never shortens anything.
	maxStretchedInterval = 2 * time.Hour
)

// StretchedInterval is how long the full refresh waits while every tracked
// repo has a healthy webhook: stretchFactor times interval, up to
// maxStretchedInterval, and never less than interval itself. With the default
// 20 minutes that is 80.
func StretchedInterval(interval time.Duration) time.Duration {
	// Past the cap there is nothing to stretch, and multiplying could wrap
	// negative and turn the timer into a busy loop.
	if interval >= maxStretchedInterval {
		return interval
	}

	return min(stretchFactor*interval, maxStretchedInterval)
}

// webhooksCover reports whether every tracked repo in snap has a healthy
// webhook, so deliveries are what keeps the board current and the full refresh
// is only a safety net. No repos at all is not coverage: there is nothing to
// rely on yet. Neither are the repos of a forge whose last fetch failed: they
// are the earlier ones, carried over with the hook state they had then.
//
// Only the live hook check counts, not the recorded deliveries the Webhooks
// page ORs in. A delivery that arrived once does not show the hook is still
// there, and the wait should not stretch on that.
func webhooksCover(snap Snapshot) bool {
	if len(snap.Repos) == 0 {
		return false
	}
	// A forge that was never reachable has no repos to check, so its silence
	// would otherwise read as coverage.
	failed := map[Forge]bool{}
	for _, h := range snap.Forges {
		if !h.Reachable {
			return false
		}
		if h.StaleSince != nil {
			failed[h.Forge] = true
		}
	}
	for _, repo := range snap.Repos {
		if !repo.HasWebhook || failed[repo.Forge] {
			return false
		}
	}

	return true
}

// NextDelay is how long Run waits before the next scheduled full refresh:
// interval, stretched while every repo has a healthy webhook, then pushed out
// further by NextRefreshDelay if a forge's budget is critically low.
func (a *Aggregator) NextDelay(interval time.Duration) time.Duration {
	snap := a.Get()
	if webhooksCover(snap) {
		interval = StretchedInterval(interval)
	}

	return NextRefreshDelay(snap, interval)
}
