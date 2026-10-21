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
	return min(stretchFactor*interval, max(maxStretchedInterval, interval))
}

// webhooksCover reports whether every tracked repo in snap has a healthy
// webhook, so deliveries are what keeps the board current and the full refresh
// is only a safety net. No repos at all is not coverage: there is nothing to
// rely on yet.
func webhooksCover(snap Snapshot) bool {
	if len(snap.Repos) == 0 {
		return false
	}
	for _, repo := range snap.Repos {
		if !repo.HasWebhook {
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
