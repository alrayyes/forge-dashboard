package dashboard

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestUpToDateRuleCache_KeepsAKnownAnswerFiveMinutesAndAnUnknownOneMinute(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	cache := &UpToDateRuleCache{now: func() time.Time { return now }}
	cache.Store("o/r@main", new(true))
	cache.Store("o/r@dev", nil)

	now = now.Add(time.Minute)
	known, ok := cache.Cached("o/r@main")
	assert.True(t, ok)
	assert.True(t, *known)
	_, ok = cache.Cached("o/r@dev")
	assert.True(t, ok, "an unknown answer is still fresh at exactly one minute")

	now = now.Add(time.Second)
	_, ok = cache.Cached("o/r@dev")
	assert.False(t, ok, "an unknown answer expires after one minute")
	_, ok = cache.Cached("o/r@main")
	assert.True(t, ok)

	now = now.Add(4*time.Minute - time.Second)
	_, ok = cache.Cached("o/r@main")
	assert.True(t, ok, "a known answer is still fresh at exactly five minutes")

	now = now.Add(time.Second)
	_, ok = cache.Cached("o/r@main")
	assert.False(t, ok, "a known answer expires after five minutes")
}

func TestUpToDateRuleCache_StoreDropsEntriesThatHaveExpired(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)
	cache := &UpToDateRuleCache{now: func() time.Time { return now }}
	cache.Store("o/r@old-known", new(true))
	cache.Store("o/r@old-unknown", nil)

	now = now.Add(time.Minute + time.Second)
	cache.Store("o/r@new", nil)
	assert.Len(t, cache.answers, 2, "the unknown answer expired, the known one has not")

	now = now.Add(5 * time.Minute)
	cache.Store("o/r@newer", nil)
	assert.Len(t, cache.answers, 1)
}
