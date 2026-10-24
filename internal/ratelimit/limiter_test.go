package ratelimit_test

import (
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/ratelimit"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time          { return c.now }
func (c *clock) advance(d time.Duration) { c.now = c.now.Add(d) }

func newLimiter(burst int, every time.Duration) (*ratelimit.Limiter, *clock) {
	c := &clock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}

	return ratelimit.New(burst, every, c.Now), c
}

func TestLimiter_UnderTheBurst_AllowsEveryRequest(t *testing.T) {
	t.Parallel()
	l, _ := newLimiter(3, time.Second)

	for range 3 {
		ok, _ := l.Allow("a")
		assert.True(t, ok)
	}
}

func TestLimiter_PastTheBurst_RefusesAndSaysHowLongToWait(t *testing.T) {
	t.Parallel()
	l, _ := newLimiter(3, 6*time.Second)
	for range 3 {
		l.Allow("a")
	}

	ok, wait := l.Allow("a")

	assert.False(t, ok)
	assert.Equal(t, 6*time.Second, wait)
}

func TestLimiter_RefusedRequest_DoesNotPushTheWaitOut(t *testing.T) {
	t.Parallel()
	l, _ := newLimiter(1, 6*time.Second)
	l.Allow("a")
	for range 5 {
		l.Allow("a")
	}

	_, wait := l.Allow("a")

	assert.Equal(t, 6*time.Second, wait)
}

func TestLimiter_AfterTheWindow_AllowsAgain(t *testing.T) {
	t.Parallel()
	l, c := newLimiter(2, 6*time.Second)
	l.Allow("a")
	l.Allow("a")
	ok, _ := l.Allow("a")
	require.False(t, ok)

	c.advance(6 * time.Second)

	ok, _ = l.Allow("a")
	assert.True(t, ok)
	ok, _ = l.Allow("a")
	assert.False(t, ok, "only one token came back")
}

func TestLimiter_EachKeyHasItsOwnAllowance(t *testing.T) {
	t.Parallel()
	l, _ := newLimiter(1, time.Minute)
	l.Allow("scanner")
	ok, _ := l.Allow("scanner")
	require.False(t, ok)

	ok, _ = l.Allow("owner")

	assert.True(t, ok)
}

func TestLimiter_IdleKeys_AreForgotten(t *testing.T) {
	t.Parallel()
	l, c := newLimiter(2, 6*time.Second)
	for i := range 50 {
		l.Allow(string(rune('a' + i)))
	}
	require.Equal(t, 50, l.Tracked())

	c.advance(2 * time.Minute)
	l.Allow("late")

	assert.Equal(t, 1, l.Tracked())
}

func TestLimiter_SweepKeepsAKeyStillOverItsAllowance(t *testing.T) {
	t.Parallel()
	l, c := newLimiter(1, time.Hour)
	l.Allow("scanner")
	c.advance(2 * time.Minute)
	l.Allow("other")

	ok, _ := l.Allow("scanner")

	assert.False(t, ok, "a limited address does not get a fresh allowance from the sweep")
}

// Many goroutines hit the same and different keys at once. Under -race this
// fails if the mutex is dropped; the count shows no request is lost or doubled.
func TestLimiter_ConcurrentAllow_GrantsExactlyTheBurstPerKey(t *testing.T) {
	t.Parallel()
	const (
		burst   = 5
		keys    = 8
		callers = 40
	)
	l, _ := newLimiter(burst, time.Hour)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		allowed = make(map[string]int)
	)
	for i := range keys * callers {
		wg.Go(func() {
			key := strconv.Itoa(i % keys)
			if ok, _ := l.Allow(key); ok {
				mu.Lock()
				allowed[key]++
				mu.Unlock()
			}
		})
	}
	wg.Wait()

	assert.Len(t, allowed, keys)
	for key, n := range allowed {
		assert.Equal(t, burst, n, "key %s", key)
	}
	assert.Equal(t, keys, l.Tracked())
}

func TestLimiter_AllowUnattributed_SharesOneBucketTwiceTheBurst(t *testing.T) {
	t.Parallel()
	l, c := newLimiter(3, 6*time.Second)
	for range 6 {
		ok, _ := l.AllowUnattributed()
		assert.True(t, ok)
	}

	ok, wait := l.AllowUnattributed()

	assert.False(t, ok)
	assert.Equal(t, 6*time.Second, wait)
	c.advance(6 * time.Second)
	ok, _ = l.AllowUnattributed()
	assert.True(t, ok, "one more every `every`, like any other key")
}

func TestLimiter_AllowUnattributed_LeavesEveryAddressAlone(t *testing.T) {
	t.Parallel()
	l, _ := newLimiter(3, time.Hour)
	for range 7 {
		l.AllowUnattributed()
	}

	ok, _ := l.Allow("198.51.100.1")

	assert.True(t, ok)
	assert.Equal(t, 1, l.Tracked(), "the shared bucket is not a tracked address")
}
