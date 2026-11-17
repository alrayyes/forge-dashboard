package api

import (
	"strings"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
)

func TestJobLogCache_KeepsWhatItWasGiven(t *testing.T) {
	t.Parallel()

	c := newJobLogCache(1 << 20)
	k := jobLogKey{forge: "github", fullName: "a/b", jobID: 1, attempt: 1, finishedAt: time.Unix(100, 0)}
	c.put(k, dashboard.JobLog{Text: "hello", Truncated: true})

	got, ok := c.get(k)
	assert.True(t, ok)
	assert.Equal(t, dashboard.JobLog{Text: "hello", Truncated: true}, got)
}

func TestJobLogCache_KeyIncludesAttemptAndFinishTime(t *testing.T) {
	t.Parallel()

	c := newJobLogCache(1 << 20)
	k := jobLogKey{forge: "forgejo", fullName: "a/b", jobID: 1, attempt: 1, finishedAt: time.Unix(100, 0)}
	c.put(k, dashboard.JobLog{Text: "first"})

	rerun := k
	rerun.attempt = 2
	_, ok := c.get(rerun)
	assert.False(t, ok, "a rerun's attempt reads fresh")

	later := k
	later.finishedAt = time.Unix(200, 0)
	_, ok = c.get(later)
	assert.False(t, ok, "a later finish reads fresh")
}

func TestJobLogCache_RepoNameIgnoresCase(t *testing.T) {
	t.Parallel()

	c := newJobLogCache(1 << 20)
	k := jobLogKey{forge: "github", fullName: "Acme/Api", jobID: 1, finishedAt: time.Unix(100, 0)}
	c.put(k, dashboard.JobLog{Text: "x"})

	k.fullName = "acme/api"
	_, ok := c.get(k)
	assert.True(t, ok)
}

func TestJobLogCache_StaysUnderItsByteBudget_LeastRecentlyReadGoesFirst(t *testing.T) {
	t.Parallel()

	c := newJobLogCache(100)
	key := func(id int64) jobLogKey {
		return jobLogKey{forge: "github", fullName: "a/b", jobID: id, finishedAt: time.Unix(100, 0)}
	}
	big := dashboard.JobLog{Text: strings.Repeat("x", 40)}
	c.put(key(1), big)
	c.put(key(2), big)
	_, _ = c.get(key(1)) // 1 is now the most recently read
	c.put(key(3), big)   // 120 bytes: 2 goes

	_, ok1 := c.get(key(1))
	_, ok2 := c.get(key(2))
	_, ok3 := c.get(key(3))
	assert.True(t, ok1)
	assert.False(t, ok2)
	assert.True(t, ok3)
	assert.LessOrEqual(t, c.size, 100)
}

func TestJobLogCache_RefusesALogLargerThanItsBudget(t *testing.T) {
	t.Parallel()

	c := newJobLogCache(10)
	k := jobLogKey{forge: "github", fullName: "a/b", jobID: 1, finishedAt: time.Unix(100, 0)}
	c.put(k, dashboard.JobLog{Text: strings.Repeat("x", 11)})

	_, ok := c.get(k)
	assert.False(t, ok)
	assert.Zero(t, c.size)
}

func TestJobLogSettled(t *testing.T) {
	t.Parallel()

	now := time.Unix(1000, 0)
	assert.False(t, jobLogSettled(time.Time{}, now), "no finish time: unknown")
	assert.False(t, jobLogSettled(now.Add(-jobLogSettleDelay+time.Second), now), "just finished")
	assert.False(t, jobLogSettled(now.Add(time.Hour), now), "finish in the future")
	assert.True(t, jobLogSettled(now.Add(-jobLogSettleDelay), now))
}
