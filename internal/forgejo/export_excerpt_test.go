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

func (e *ExcerptCacheForTest) Fail(key string) { e.c.fail(key) }

func (e *ExcerptCacheForTest) RecentlyFailed(key string) bool { return e.c.recentlyFailed(key) }
