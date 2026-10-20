package dashboard

import (
	"context"
	"sync"
	"time"
)

// How long a repo's webhook events are held back before the one scoped
// refresh they cause. A push sends several deliveries in a burst (the push,
// the pull request update, each check suite), and one refresh after the last
// of them reads all of that, where one refresh per delivery paid for the same
// fetch several times.
//
// quiet is the gap that ends a burst: the refresh runs this long after the
// newest event. maxHold caps the whole wait, counted from the first event, so
// a repo whose events never stop (a busy CI) still refreshes instead of being
// pushed back for ever. A lone event therefore waits webhookQuiet, and no
// event waits longer than webhookMaxHold.
const (
	webhookQuiet   = 2 * time.Second
	webhookMaxHold = 5 * time.Second
)

// AfterFunc runs f once, after d, and returns a function that cancels it and
// reports whether it did so before f started. time.AfterFunc is the real one;
// WithDebounceTimer lets a test supply its own.
type AfterFunc func(d time.Duration, f func()) (stop func() bool)

func realAfterFunc(d time.Duration, f func()) func() bool {
	return time.AfterFunc(d, f).Stop
}

// debouncer turns a burst of calls for one key into a single call of the
// latest fn, quiet after the newest and at most maxHold after the first. It
// holds an entry only while a call is pending, so memory is bounded by the
// number of repos with events in flight, and an idle debouncer holds nothing.
// It starts no goroutine of its own: the timer's callback is the only code
// that runs, and a cancelled context removes its entry and stops its timer.
type debouncer struct {
	now     func() time.Time
	after   AfterFunc
	quiet   time.Duration
	maxHold time.Duration

	mu      sync.Mutex
	entries map[string]*debounceEntry
}

type debounceEntry struct {
	first time.Time
	fn    func()
	// gen counts the events folded into this entry. A timer only fires the
	// entry if it is still the newest, so a callback that was already running
	// when a later event reset the timer finds nothing to do.
	gen     uint64
	stop    func() bool
	release func() bool
}

func newDebouncer(now func() time.Time, after AfterFunc, quiet, maxHold time.Duration) *debouncer {
	return &debouncer{now: now, after: after, quiet: quiet, maxHold: maxHold, entries: make(map[string]*debounceEntry)}
}

// Submit records an event for key. fn runs once, after the burst, with the
// latest fn of the burst. Cancelling ctx drops the pending call.
func (d *debouncer) Submit(ctx context.Context, key string, fn func()) {
	d.mu.Lock()
	defer d.mu.Unlock()

	now := d.now()
	e, ok := d.entries[key]
	if ok {
		e.stop()
		e.release()
	} else {
		e = &debounceEntry{first: now}
		d.entries[key] = e
	}
	e.gen++
	e.fn = fn

	wait := d.quiet
	if left := d.maxHold - now.Sub(e.first); left < wait {
		wait = max(left, 0)
	}
	gen := e.gen
	e.stop = d.after(wait, func() { d.fire(key, gen) })
	e.release = context.AfterFunc(ctx, func() { d.drop(key, gen) })
}

func (d *debouncer) fire(key string, gen uint64) {
	d.mu.Lock()
	e, ok := d.entries[key]
	if !ok || e.gen != gen {
		d.mu.Unlock()

		return
	}
	delete(d.entries, key)
	e.release()
	fn := e.fn
	d.mu.Unlock()

	fn()
}

func (d *debouncer) drop(key string, gen uint64) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if e, ok := d.entries[key]; ok && e.gen == gen {
		e.stop()
		delete(d.entries, key)
	}
}

// WithDebounceTimer sets the timer the webhook debouncer schedules with, for
// tests that drive time by hand. The clock it measures the cap against is
// WithClock's.
func WithDebounceTimer(after AfterFunc) AggregatorOption {
	return func(a *Aggregator) { a.after = after }
}

// RefreshRepoDebounced is RefreshRepo for a webhook delivery: events for one
// repo that arrive close together cause one scoped refresh after the last of
// them, not one each. Polls, force refreshes and user actions call RefreshRepo
// (or Refresh) directly and are never held back.
//
// It reports false at once, arming nothing, when no Source can do a scoped
// fetch for forge, so the caller falls back to a full refresh without waiting.
// A true answer means the refresh was accepted and will run after the window,
// not that it has run. Each Aggregator has its own debouncer, so one user's
// event never absorbs another's. A refresh already running for the repo is not
// interrupted: an event that arrives during it starts a new window, and the
// refresh that follows merges into the coalescer's one trailing run.
func (a *Aggregator) RefreshRepoDebounced(ctx context.Context, forge Forge, owner, name, fullName string, attrs ...any) bool {
	if a.repoRefresherFor(forge) == nil {
		return false
	}
	a.debounce.Submit(ctx, string(forge)+"/"+fullName, func() {
		a.RefreshRepo(ctx, forge, owner, name, fullName, attrs...)
	})

	return true
}
