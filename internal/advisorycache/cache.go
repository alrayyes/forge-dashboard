// Package advisorycache holds what the GitHub and Forgejo advisory sources
// share: how long an answer is reused, how soon a failed read is asked again,
// and the per-repo cache that remembers both. Keeping them in one place stops
// the two sources drifting apart.
package advisorycache

import (
	"cmp"
	"sync"
	"time"
)

// TTL is how long a repo's advisory answer is reused. Advisories change on the
// scale of hours, and a webhook-scoped refresh would otherwise ask again for
// every finished check.
const TTL = 15 * time.Minute

// Retry is how long a failed read, or a first refusal, waits before it is
// tried again, so an outage or a spent rate limit costs one call per repo per
// interval, not one per refresh.
const Retry = 5 * time.Minute

// RetryMax caps Backoff.
const RetryMax = 30 * time.Minute

// DefaultMax is how many repos a Cache remembers when Max is zero.
const DefaultMax = 5000

// Backoff is how long to wait after the given number of failed reads in a row:
// Retry, then twice that, and so on up to RetryMax.
func Backoff(failures int) time.Duration {
	return min(Retry<<min(max(failures-1, 0), 6), RetryMax)
}

// Cache remembers each repo's last answer, of whatever shape the source needs,
// and when to ask again. The zero value is ready to use.
type Cache[E any] struct {
	// Max is how many entries are kept; zero means DefaultMax.
	Max int
	// Now replaces the clock; nil means time.Now. For tests.
	Now func() time.Time
	// Hold, when set, names a time until which an entry is kept even after it
	// has expired, because the source still has a use for it.
	Hold func(E) time.Time

	mu      sync.Mutex
	entries map[string]slot[E]
}

type slot[E any] struct {
	value   E
	expires time.Time
}

// Clock is the current time by the cache's own clock.
func (c *Cache[E]) Clock() time.Time {
	if c.Now != nil {
		return c.Now()
	}

	return time.Now()
}

// Get returns the entry, whether it is still fresh, and whether there is one
// at all. An expired entry is returned too, to fall back on.
func (c *Cache[E]) Get(key string) (e E, fresh, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	s, ok := c.entries[key]

	return s.value, ok && c.Clock().Before(s.expires), ok
}

// Put stores e to be reused for ttl.
func (c *Cache[E]) Put(key string, e E, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.put(key, e, ttl)
}

// Update replaces the entry with what fn makes of the old one, atomically. ok
// says whether there was an old one.
func (c *Cache[E]) Update(key string, fn func(old E, ok bool) (E, time.Duration)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	old, ok := c.entries[key]
	e, ttl := fn(old.value, ok)
	c.put(key, e, ttl)
}

// Len is how many entries are held.
func (c *Cache[E]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	return len(c.entries)
}

// Expire ages every entry past its lifetime, so the next Get is not fresh.
func (c *Cache[E]) Expire() {
	c.mu.Lock()
	defer c.mu.Unlock()
	past := c.Clock().Add(-time.Second)
	for k, s := range c.entries {
		s.expires = past
		c.entries[k] = s
	}
}

// Remaining is how long the entry has left to be fresh, zero or negative when
// it is spent or missing.
func (c *Cache[E]) Remaining(key string) time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()

	return c.entries[key].expires.Sub(c.Clock())
}

func (c *Cache[E]) put(key string, e E, ttl time.Duration) {
	if c.entries == nil {
		c.entries = map[string]slot[E]{}
	}
	c.entries[key] = slot[E]{value: e, expires: c.Clock().Add(ttl)}
	if len(c.entries) > cmp.Or(c.Max, DefaultMax) {
		c.evict(key)
	}
}

// evict makes room: it drops entries that have expired and are not held, then,
// if the cache is still over its limit, others, keeping the entry just
// written. Call it with the lock held.
func (c *Cache[E]) evict(keep string) {
	now := c.Clock()
	limit := cmp.Or(c.Max, DefaultMax)
	for k, s := range c.entries {
		if k == keep || now.Before(s.expires) {
			continue
		}
		if c.Hold != nil && now.Before(c.Hold(s.value)) {
			continue
		}
		delete(c.entries, k)
	}
	for k := range c.entries {
		if len(c.entries) <= limit {
			return
		}
		if k != keep {
			delete(c.entries, k)
		}
	}
}
