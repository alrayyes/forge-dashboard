package forgejo

import "time"

// SetExcerptReadTimeoutForTest shortens how long c waits on one job log.
func SetExcerptReadTimeoutForTest(c *Client, d time.Duration) {
	c.excerptTimeout = d
}

// ExcerptCacheForTest exposes the failure memory with a clock of its own.
type ExcerptCacheForTest struct{ c *excerptCache }

func NewExcerptCacheForTest(now func() time.Time) *ExcerptCacheForTest {
	c := newExcerptCache(maxExcerpts)
	c.now = now

	return &ExcerptCacheForTest{c}
}

// Put keeps text under key; final false keeps it only for the failure delay.
func (e *ExcerptCacheForTest) Put(key, text string, final bool) { e.c.put(key, text, final) }

func (e *ExcerptCacheForTest) Get(key string) (string, bool) { return e.c.get(key) }

func (e *ExcerptCacheForTest) Fail(key string) { e.c.fail(key) }

func (e *ExcerptCacheForTest) RecentlyFailed(key string) bool { return e.c.recentlyFailed(key) }

// ExcerptReadWindow is the size of the log tail an excerpt read keeps.
const ExcerptReadWindow = excerptReadWindow

// MaxExcerptsForTest is how many entries the excerpt cache holds.
const MaxExcerptsForTest = maxExcerpts
