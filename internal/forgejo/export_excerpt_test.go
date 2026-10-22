package forgejo

import (
	"context"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
)

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

// ExcerptReadWindow is the size of the log tail an excerpt read keeps.
const ExcerptReadWindow = excerptReadWindow

// AddFailureExcerptsForTest runs the excerpt reads for checks under ctx.
func AddFailureExcerptsForTest(ctx context.Context, c *Client, owner, name string, checks []dashboard.Check, keys []string) {
	c.addFailureExcerpts(ctx, owner, name, checks, keys)
}
