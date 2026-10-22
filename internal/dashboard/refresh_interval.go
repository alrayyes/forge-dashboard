package dashboard

import "time"

const (
	// stretchFactor is how many times longer the full refresh waits while
	// every tracked repo has a healthy webhook.
	stretchFactor = 4
	// maxStretchedInterval caps the stretch. A configured interval already past
	// it is kept as it is: the stretch never shortens anything.
	maxStretchedInterval = 2 * time.Hour
	// permanentFailureIntervals is how many refresh intervals a repo may stay
	// stale before it counts as failing for good. A repo that fails the same
	// way on every refresh (issues disabled, an empty repo, a token without
	// the scope) would otherwise hold the short wait for every other repo.
	permanentFailureIntervals = 3
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
// rely on yet. Neither are the repos of a forge whose last fetch failed, or a repo
// the forge could not fully fetch: their rows are the earlier ones, stale, so
// the full refresh should retry sooner. A repo that has been stale for
// permanentFailureIntervals refresh intervals is failing for good and no longer
// counts: retrying sooner has not helped, and it would keep the short wait for
// everyone else.
//
// Only the live hook check counts, not the recorded deliveries the Webhooks
// page ORs in. A delivery that arrived once does not show the hook is still
// there, and the wait should not stretch on that.
func webhooksCover(snap Snapshot, interval time.Duration, now time.Time) bool {
	if len(snap.Repos) == 0 {
		return false
	}
	// A forge that was never reachable has no repos to check, so its silence
	// would otherwise read as coverage. A forge that failed after a good fetch
	// has carried-over repos, and this check catches that too.
	for _, h := range snap.Forges {
		if !h.Reachable {
			return false
		}
	}
	// A reachable forge can still have failed on one repo. That repo is the
	// earlier one, marked stale, so retry sooner, until it has failed for good.
	for _, repo := range snap.Repos {
		if !repo.HasWebhook {
			return false
		}
		if repo.StaleSince != nil && now.Sub(*repo.StaleSince) < permanentFailureIntervals*interval {
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
	if webhooksCover(snap, interval, time.Now()) {
		interval = StretchedInterval(interval)
	}

	return NextRefreshDelay(snap, interval)
}
