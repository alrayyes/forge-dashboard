package dashboard

import (
	"fmt"
	"strconv"
	"sync"
	"time"
)

// pendingPollCap is the longest a pull request that keeps reading the same is
// left between polls. A base interval above it wins, so the cap never makes
// a poll more frequent than the configured one.
const pendingPollCap = 15 * time.Minute

// overdueMultiple is how many base poll intervals a repo's check deliveries may
// go quiet before its hook is no longer trusted and the repo is polled again.
// It is the design's starting value; nothing in the call counts so far argues
// for another.
const overdueMultiple = 3

// pendingSchedule decides which pending pull requests a CI poll tick asks
// about. A pull request that reads the same after a poll waits twice as long
// before the next one, up to pendingPollCap; any change puts it back to the
// base interval. Entries are keyed forge/repo#number and hold no user id.
type pendingSchedule struct {
	mu      sync.Mutex
	entries map[string]*pendingEntry
}

type pendingEntry struct {
	// next is when the pull request is due again.
	next time.Time
	// interval is the gap the next unchanged poll will schedule.
	interval time.Duration
}

// due reports whether key is due at now. A key the schedule has not seen is
// due. Ticks arrive on a ticker, so one that lands a little early still counts.
func (s *pendingSchedule) due(key string, now time.Time, base time.Duration) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.entries[key]
	if !ok {
		return true
	}

	return !now.Add(base / 2).Before(e.next)
}

// polled records a poll of key at now, and whether the pull request changed
// since the poll before it.
func (s *pendingSchedule) polled(key string, now time.Time, base time.Duration, changed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.entries == nil {
		s.entries = make(map[string]*pendingEntry)
	}
	e, ok := s.entries[key]
	if !ok || changed {
		e = &pendingEntry{interval: base}
		s.entries[key] = e
	}
	e.next = now.Add(e.interval)
	e.interval = min(e.interval*2, max(pendingPollCap, base))
}

// keepOnly drops every entry whose key is not in live, so a pull request that
// stopped being pending starts over if it becomes pending again.
func (s *pendingSchedule) keepOnly(live map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	for key := range s.entries {
		if _, ok := live[key]; !ok {
			delete(s.entries, key)
		}
	}
}

// pullRequestKey is a pull request's schedule key.
func pullRequestKey(forge Forge, repo string, number int) string {
	return fmt.Sprintf("%s/%s#%d", forge, repo, number)
}

// pollFingerprint is what a CI poll can change about a pull request. Two polls
// with the same fingerprint saw nothing happen.
func pollFingerprint(pr PullRequest) string {
	autoMerge := "unknown"
	if pr.AutoMergeEnabled != nil {
		autoMerge = strconv.FormatBool(*pr.AutoMergeEnabled)
	}

	return fmt.Sprintf("%v|%+v|%v|%s|%s|%v", pr.CI, pr.Checks, pr.MergeStatus, autoMerge, pr.HeadSHA, pr.Behind)
}
