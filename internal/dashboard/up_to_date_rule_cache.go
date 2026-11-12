package dashboard

import (
	"sync"
	"time"
)

// upToDateRuleTTL is how long a branch's up-to-date rule is reused. Protection
// rules change rarely, so a busy refresh doesn't ask again.
const upToDateRuleTTL = 5 * time.Minute

// unknownUpToDateRuleTTL is how long an unreadable answer is reused. Short
// enough that a lookup that was only flaky is retried soon; long enough that a
// repo whose protection can't be read isn't asked about on every poll.
const unknownUpToDateRuleTTL = time.Minute

// UpToDateRuleCache remembers each branch's answer to "must a pull request be
// up to date to merge" (#3428), so a refresh reads the forge's protection once
// per branch instead of once per pull request. The zero value is ready to use.
// Store drops the entries that have expired, so it holds only the pairs seen
// within the last few minutes.
type UpToDateRuleCache struct {
	mu      sync.Mutex
	answers map[string]upToDateAnswer
	// now is the clock; nil means time.Now. A test sets it to pin the TTLs.
	now func() time.Time
}

func (c *UpToDateRuleCache) clock() time.Time {
	if c.now != nil {
		return c.now()
	}

	return time.Now()
}

type upToDateAnswer struct {
	// required is nil when the rule couldn't be read.
	required *bool
	fetched  time.Time
}

// Cached returns the remembered answer for key and whether there is a fresh
// one. A nil answer is a remembered "unknown".
func (c *UpToDateRuleCache) Cached(key string) (*bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	a, found := c.answers[key]
	if !found || a.expired(c.clock()) {
		return nil, false
	}

	return a.required, true
}

func (a upToDateAnswer) expired(now time.Time) bool {
	ttl := upToDateRuleTTL
	if a.required == nil {
		ttl = unknownUpToDateRuleTTL
	}

	return now.Sub(a.fetched) > ttl
}

// Store remembers required for key; nil means the rule couldn't be read.
func (c *UpToDateRuleCache) Store(key string, required *bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.answers == nil {
		c.answers = map[string]upToDateAnswer{}
	}
	now := c.clock()
	for k, a := range c.answers {
		if a.expired(now) {
			delete(c.answers, k)
		}
	}
	c.answers[key] = upToDateAnswer{required: required, fetched: now}
}
