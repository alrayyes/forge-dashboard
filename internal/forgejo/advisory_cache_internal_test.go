package forgejo

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestAdvisoryCache_DropsExpiredEntriesWhenFull(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := &advisoryCache{max: 3, now: func() time.Time { return now }}

	c.put("gone-1", advisoryEntry{}, time.Minute)
	c.put("gone-2", advisoryEntry{pkgs: nil}, time.Minute)
	now = now.Add(time.Hour)
	c.put("live-1", advisoryEntry{}, time.Hour)
	c.put("live-2", advisoryEntry{}, time.Hour)

	assert.Len(t, c.entries, 2, "the two expired entries went when the cache filled")
	assert.Contains(t, c.entries, "live-1")
	assert.Contains(t, c.entries, "live-2")
}

func TestAdvisoryCache_NeverGrowsPastItsLimit(t *testing.T) {
	t.Parallel()
	c := &advisoryCache{max: 3}
	for _, k := range []string{"a", "b", "c", "d", "e"} {
		c.put(k, advisoryEntry{}, time.Hour)
	}
	assert.LessOrEqual(t, len(c.entries), 3)
	assert.Contains(t, c.entries, "e", "the newest entry is kept")
}
