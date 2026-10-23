package advisorycache_test

import (
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/advisorycache"
	"github.com/stretchr/testify/assert"
)

type entry struct {
	n    int
	hold time.Time
}

func clockAt(t *time.Time) func() time.Time { return func() time.Time { return *t } }

func TestLifetimes(t *testing.T) {
	t.Parallel()
	assert.Equal(t, 15*time.Minute, advisorycache.TTL)
	assert.Equal(t, 5*time.Minute, advisorycache.Retry)
	assert.Equal(t, 30*time.Minute, advisorycache.RetryMax)
}

func TestBackoff_DoublesPerFailureUpToTheCap(t *testing.T) {
	t.Parallel()
	assert.Equal(t, 5*time.Minute, advisorycache.Backoff(1))
	assert.Equal(t, 10*time.Minute, advisorycache.Backoff(2))
	assert.Equal(t, 20*time.Minute, advisorycache.Backoff(3))
	assert.Equal(t, 30*time.Minute, advisorycache.Backoff(4))
	assert.Equal(t, 30*time.Minute, advisorycache.Backoff(500))
}

func TestCache_AnswerIsFreshUntilItsLifetimeEnds(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisorycache.Cache[entry]{Now: clockAt(&now)}

	_, fresh, ok := c.Get("a")
	assert.False(t, ok)
	assert.False(t, fresh)

	c.Put("a", entry{n: 1}, advisorycache.TTL)
	e, fresh, ok := c.Get("a")
	assert.True(t, ok)
	assert.True(t, fresh)
	assert.Equal(t, 1, e.n)

	now = now.Add(advisorycache.TTL)
	e, fresh, ok = c.Get("a")
	assert.True(t, ok, "an expired entry is still there to fall back on")
	assert.False(t, fresh)
	assert.Equal(t, 1, e.n)
}

func TestCache_UpdateSeesTheOldEntryAndPicksTheLifetime(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisorycache.Cache[entry]{Now: clockAt(&now)}
	c.Put("a", entry{n: 1}, time.Hour)

	c.Update("a", func(old entry, ok bool) (entry, time.Duration) {
		assert.True(t, ok)

		return entry{n: old.n + 1}, advisorycache.Retry
	})

	e, fresh, _ := c.Get("a")
	assert.Equal(t, 2, e.n)
	assert.True(t, fresh)
	now = now.Add(advisorycache.Retry)
	_, fresh, _ = c.Get("a")
	assert.False(t, fresh)
}

func TestCache_DropsExpiredEntriesWhenFull(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisorycache.Cache[entry]{Max: 3, Now: clockAt(&now)}

	c.Put("gone-1", entry{}, time.Minute)
	c.Put("gone-2", entry{}, time.Minute)
	now = now.Add(time.Hour)
	c.Put("live-1", entry{}, time.Hour)
	c.Put("live-2", entry{}, time.Hour)

	assert.Equal(t, 2, c.Len())
	_, _, ok := c.Get("gone-1")
	assert.False(t, ok)
}

func TestCache_KeepsAnExpiredEntryItIsHoldingFor(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisorycache.Cache[entry]{Max: 2, Now: clockAt(&now), Hold: func(e entry) time.Time { return e.hold }}

	c.Put("held", entry{hold: now.Add(2 * time.Hour)}, time.Minute)
	c.Put("plain", entry{}, time.Minute)
	now = now.Add(time.Hour)
	c.Put("new", entry{}, time.Hour)

	_, _, held := c.Get("held")
	_, _, plain := c.Get("plain")
	assert.True(t, held)
	assert.False(t, plain)
}

func TestCache_NeverGrowsPastItsLimit(t *testing.T) {
	t.Parallel()
	c := &advisorycache.Cache[entry]{Max: 3}
	for _, k := range []string{"a", "b", "c", "d", "e"} {
		c.Put(k, entry{}, time.Hour)
	}
	assert.LessOrEqual(t, c.Len(), 3)
	_, _, ok := c.Get("e")
	assert.True(t, ok, "the newest entry is kept")
}
