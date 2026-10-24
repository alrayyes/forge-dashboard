// Package ratelimit holds the per-client allowance in front of the sign-in and
// registration endpoints, and the rule for which address a request counts
// against.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// sweepEvery is how often Allow drops keys that have nothing left to remember.
const sweepEvery = time.Minute

// Limiter is a token bucket per key: each key may make burst requests at once
// and then one more every `every`. It is safe for concurrent use.
type Limiter struct {
	mu        sync.Mutex
	burst     int
	every     time.Duration
	now       func() time.Time
	buckets   map[string]*rate.Limiter
	lastSweep time.Time
}

// New returns a Limiter reading the time from now.
func New(burst int, every time.Duration, now func() time.Time) *Limiter {
	return &Limiter{
		burst:     burst,
		every:     every,
		now:       now,
		buckets:   make(map[string]*rate.Limiter),
		lastSweep: now(),
	}
}

// Allow takes one request from key's allowance. When none is left it takes
// nothing, so a client that keeps knocking does not push its own wait out, and
// returns how long until one is.
func (l *Limiter) Allow(key string) (allowed bool, wait time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.sweep(now)

	bucket, ok := l.buckets[key]
	if !ok {
		bucket = rate.NewLimiter(rate.Every(l.every), l.burst)
		l.buckets[key] = bucket
	}

	reservation := bucket.ReserveN(now, 1)
	if !reservation.OK() {
		return false, l.every
	}
	if delay := reservation.DelayFrom(now); delay > 0 {
		reservation.CancelAt(now)

		return false, delay
	}

	return true, 0
}

// Tracked is how many keys the Limiter currently remembers.
func (l *Limiter) Tracked() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return len(l.buckets)
}

// sweep forgets keys whose bucket has refilled: they behave exactly like a key
// never seen, so the map holds only addresses that were recently busy.
func (l *Limiter) sweep(now time.Time) {
	if now.Sub(l.lastSweep) < sweepEvery {
		return
	}
	l.lastSweep = now
	for key, bucket := range l.buckets {
		if bucket.TokensAt(now) >= float64(l.burst) {
			delete(l.buckets, key)
		}
	}
}
