package dashboard

import (
	"context"
	"log/slog"
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
// pushed back for ever. A lone event therefore waits webhookQuiet, and an
// event waits no longer than webhookMaxHold unless the minimum interval, below,
// holds it back further.
//
// A push's check runs send events over tens of seconds, with gaps longer than
// quiet, so those two alone cost a refresh per event. the webhook minimum interval is the
// least time between two refreshes of one repo: an event inside it waits for it
// to pass, and the one refresh then reads everything that came in meanwhile.
// 30 seconds is the browser tab's own poll period, so a webhook refresh any
// faster than that shows up on the page no sooner than the poll would, while
// it multiplies the load on a forge that is already struggling.
// DefaultWebhookMinInterval is that default; WEBHOOK_MIN_INTERVAL changes it, and
// zero turns the throttle off.
const (
	webhookQuiet   = 2 * time.Second
	webhookMaxHold = 5 * time.Second

	DefaultWebhookMinInterval = 30 * time.Second
)

// AfterFunc runs f once, after d, and returns a function that cancels it and
// reports whether it did so before f started. time.AfterFunc is the real one;
// WithDebounceTimer lets a test supply its own.
type AfterFunc func(d time.Duration, f func()) (stop func() bool)

func realAfterFunc(d time.Duration, f func()) func() bool {
	return time.AfterFunc(d, f).Stop
}

// debouncer turns a burst of calls for one key into a single call of the
// latest fn, quiet after the newest and at most maxHold after the first,
// unless the call is put off with deferUntil. It
// holds an entry only while a call is pending, so memory is bounded by the
// number of repos with events in flight. It also remembers when each key last
// ran, until the interval is over and a later fire prunes it, so an idle
// debouncer holds at most one small entry per repo that ran recently.
// It starts no goroutine of its own: the timer's callback is the only code
// that runs, and a cancelled context removes its entry and stops its timer.
type debouncer struct {
	now     func() time.Time
	after   AfterFunc
	quiet   time.Duration
	maxHold time.Duration
	// minInterval is the least time between two calls for one key.
	minInterval time.Duration

	mu      sync.Mutex
	entries map[string]*debounceEntry
	// lastFired is when each key last ran, kept only while it still holds the
	// next call back. Guarded by mu.
	lastFired map[string]time.Time
	// closed is set when the owner's context ends; nothing is accepted after.
	closed bool
	owner  context.Context
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
	// deferred marks a call put off by deferUntil: the next event starts a
	// burst of its own, not one that has already run out of maxHold.
	deferred bool
}

// newDebouncer returns a debouncer that closes itself when owner (which may be
// nil) ends.
func newDebouncer(owner context.Context, now func() time.Time, after AfterFunc, quiet, maxHold, minInterval time.Duration) *debouncer {
	d := &debouncer{
		now: now, after: after, quiet: quiet, maxHold: maxHold, minInterval: minInterval,
		entries: make(map[string]*debounceEntry), lastFired: make(map[string]time.Time), owner: owner,
	}
	if owner != nil {
		context.AfterFunc(owner, d.close)
	}

	return d
}

// close drops every pending call and refuses new ones.
func (d *debouncer) close() {
	d.mu.Lock()
	defer d.mu.Unlock()

	d.closed = true
	for key, e := range d.entries {
		e.stop()
		e.release()
		delete(d.entries, key)
	}
	clear(d.lastFired)
}

// Submit records an event for key. fn runs once, after the burst, with the
// latest fn of the burst. Cancelling ctx drops the pending call. It reports
// false, arming nothing, once the debouncer's owner has ended.
func (d *debouncer) Submit(ctx context.Context, key string, fn func()) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	// The owner's AfterFunc runs close on its own goroutine, so ask the context too.
	if d.closed || (d.owner != nil && d.owner.Err() != nil) {
		return false
	}

	now := d.now()
	e, ok := d.entries[key]
	if ok {
		e.stop()
		e.release()
		if e.deferred {
			e.first, e.deferred = now, false
		}
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
	if last, fired := d.lastFired[key]; fired {
		wait = max(wait, last.Add(d.minInterval).Sub(now))
	}
	d.arm(ctx, key, e, wait)

	return true
}

// deferUntil runs fn at at, for a call that came due and could not be made
// yet. It does nothing when a newer event for key is already pending, since
// that event's call comes due first.
func (d *debouncer) deferUntil(ctx context.Context, key string, at time.Time, fn func()) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if _, pending := d.entries[key]; pending || d.closed {
		return
	}
	now := d.now()
	e := &debounceEntry{first: now, gen: 1, fn: fn, deferred: true}
	d.entries[key] = e
	d.arm(ctx, key, e, max(at.Sub(now), 0))
}

// arm starts e's timer. The caller holds mu.
func (d *debouncer) arm(ctx context.Context, key string, e *debounceEntry, wait time.Duration) {
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
	d.noteFired(key)
	d.mu.Unlock()

	fn()
}

// noteFired records that key ran now, and forgets the keys whose interval is
// over, so an idle debouncer holds nothing. The caller holds mu.
func (d *debouncer) noteFired(key string) {
	now := d.now()
	for k, at := range d.lastFired {
		if now.Sub(at) >= d.minInterval {
			delete(d.lastFired, k)
		}
	}
	d.lastFired[key] = now
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

// WithWebhookMinInterval sets the least time between two webhook-driven
// refreshes of one repo. Zero turns the throttle off, leaving the quiet window
// and the cap. The default is DefaultWebhookMinInterval.
func WithWebhookMinInterval(d time.Duration) AggregatorOption {
	return func(a *Aggregator) { a.webhookMinInterval = d }
}

// WithDebounceOwner ties the webhook debouncer to ctx, the lifetime of the
// Aggregator's own run: once ctx ends, every pending refresh is dropped with its
// timer and later events are refused. Without it a refresh queued for a
// removed or replaced Aggregator would still fire, up to the max hold later.
func WithDebounceOwner(ctx context.Context) AggregatorOption {
	return func(a *Aggregator) { a.debounceOwner = ctx }
}

// RefreshRepoDebounced is RefreshRepo for a webhook delivery: events for one
// repo that arrive close together cause one scoped refresh after the last of
// them, not one each, and no two refreshes of a repo start less than
// the webhook minimum interval apart. Polls, force refreshes and user actions call RefreshRepo
// (or Refresh) directly and are never held back.
//
// It reports false at once, arming nothing, when no Source can do a scoped
// fetch for forge, so the caller falls back to a full refresh without waiting.
// A true answer means the refresh was accepted and will run after the window,
// not that it has run. One that comes due with a budget at its reserve waits
// for the reset, and the events that arrive meanwhile still cost one refresh. Each Aggregator has its own debouncer, so one user's
// event never absorbs another's. A refresh already running for the repo is not
// interrupted: an event that arrives during it starts a new window, and the
// refresh that follows merges into the coalescer's one trailing run.
func (a *Aggregator) RefreshRepoDebounced(ctx context.Context, forge Forge, owner, name, fullName string, attrs ...any) bool {
	refresher := a.repoRefresherFor(forge)
	if refresher == nil {
		return false
	}

	key := string(forge) + "/" + fullName
	var refresh func()
	refresh = func() {
		if reset, held := a.scopedHold(ctx, forge, owner, name); held {
			slog.Info("webhook refresh waits for the budget to reset", "forge", forge, "repo", fullName, "resets_at", reset)
			a.debounce.deferUntil(ctx, key, reset.Add(backoffBuffer), refresh)

			return
		}
		a.fetchRepo(ctx, refresher, forge, owner, name, fullName, attrs...)
	}

	return a.debounce.Submit(ctx, key, refresh)
}
