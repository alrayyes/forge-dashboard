package advisorycache

import (
	"context"
	"sync"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

// MaxLists is how many repos' lists are kept. A list carries every advisory's
// text, so it is held to fewer entries than the counts are.
const MaxLists = 500

// Lists remembers each repo's last good advisory list, for the advisories
// dialog. The read that fills a row's count puts the list in too, so opening
// the dialog afterwards costs no call to the forge. The zero value is ready to
// use.
type Lists struct {
	// Now replaces the clock; nil means time.Now. For tests.
	Now func() time.Time

	once  sync.Once
	cache Cache[dashboard.AdvisoryList]
}

// clock is the cache, set up on first use from the fields above.
func (l *Lists) clock() *Cache[dashboard.AdvisoryList] {
	l.once.Do(func() {
		l.cache.Now = l.Now
		l.cache.Max = MaxLists
	})

	return &l.cache
}

// Get returns the kept list, whether it is still fresh, and whether there is
// one at all. An expired list is returned too: it is the last good one.
func (l *Lists) Get(key string) (list dashboard.AdvisoryList, fresh, ok bool) {
	return l.clock().Get(key)
}

// Put keeps list for ttl and stamps it with the time it was read. It returns
// the stamped list.
func (l *Lists) Put(key string, list dashboard.AdvisoryList, ttl time.Duration) dashboard.AdvisoryList {
	c := l.clock()
	list.ReadAt = c.Clock().UTC().Format(time.RFC3339)
	c.Put(key, list, ttl)

	return list
}

// Serve answers one open of the dialog. Unless fresh is asked for (see
// dashboard.WithFreshAdvisories), a list still within its TTL answers with no
// read. Otherwise read runs. A known answer is kept for TTL. An unknown one
// that says only that the read failed or was rate limited never replaces a good
// list: the good one is returned marked RefreshFailed, with its own ReadAt. Any
// other unknown answer (alerts off, no permission, too many) is the new truth
// and is kept for Retry.
func (l *Lists) Serve(ctx context.Context, key string, read func(context.Context) (dashboard.AdvisoryList, error)) (dashboard.AdvisoryList, error) {
	last, fresh, have := l.Get(key)
	if have && fresh && !dashboard.FreshAdvisories(ctx) {
		return last, nil
	}
	list, err := read(ctx)
	if err != nil {
		if have && last.State == dashboard.AdvisoriesKnown {
			last.RefreshFailed = dashboard.ReasonFailed

			return last, nil
		}

		return list, err
	}
	switch {
	case list.State == dashboard.AdvisoriesKnown:
		return l.Put(key, list, TTL), nil
	case list.Reason == dashboard.ReasonFailed || list.Reason == dashboard.ReasonThrottled:
		if have && last.State == dashboard.AdvisoriesKnown {
			last.RefreshFailed = list.Reason

			return last, nil
		}

		return list, nil
	default:
		return l.Put(key, list, Retry), nil
	}
}
