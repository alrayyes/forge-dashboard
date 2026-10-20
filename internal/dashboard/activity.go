package dashboard

import (
	"sync"
	"time"
)

// DefaultIdleAfter is how long nothing may have asked for the dashboard
// before its background refreshes rest. Fifteen minutes is long enough that
// someone who steps away for a coffee finds fresh data, and short enough that
// a dashboard left on overnight spends no forge budget for most of it.
const DefaultIdleAfter = 15 * time.Minute

// Activity records whether anyone is using the dashboard, so the background
// refresh can rest when nobody is. Two things count as use:
//
//   - a request from a signed-in browser or an API client (Touch), and
//   - an open live stream (StreamOpened until StreamClosed).
//
// An open stream counts as use for as long as it is open. The server cannot
// tell a stream in a tab someone is looking at from one in a tab on a second
// monitor nobody is looking at, and a person looking at the board who clicks
// nothing makes no request: treating their stream as idle would leave their
// board frozen until they touched something. The cost is that a tab left open
// never rests the refresh; closing every tab does. The stream's own keep-alive
// writes are not a request and never touch this.
//
// Idle is "nothing is using it and the last use was at least the idle period
// ago". A process that has only just started is not idle: its start counts as
// use. The zero idle period turns idle mode off.
//
// A nil *Activity is valid and is never idle, which is what an Aggregator
// built without idle mode holds. Safe for concurrent use.
type Activity struct {
	idleAfter time.Duration
	now       func() time.Time
	wake      chan struct{}

	mu       sync.Mutex
	lastUsed time.Time
	streams  int
}

// NewActivity returns an Activity that reports idle once nothing has used the
// dashboard for idleAfter. A nil now means time.Now.
func NewActivity(idleAfter time.Duration, now func() time.Time) *Activity {
	if now == nil {
		now = time.Now
	}

	return &Activity{
		idleAfter: idleAfter,
		now:       now,
		wake:      make(chan struct{}, 1),
		lastUsed:  now(),
	}
}

// Touch records a request from a signed-in browser or an API client.
func (a *Activity) Touch() {
	if a == nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	wasIdle := a.idleLocked()
	a.lastUsed = a.now()
	if wasIdle {
		a.signalLocked()
	}
}

// StreamOpened records that a live stream has opened. While any stream is open
// the dashboard is in use.
func (a *Activity) StreamOpened() {
	if a == nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	wasIdle := a.idleLocked()
	a.streams++
	if wasIdle {
		a.signalLocked()
	}
}

// StreamClosed records that a live stream has closed. The idle period starts
// from this moment, so closing the last tab does not make the dashboard idle
// instantly. A close with no open stream is ignored.
func (a *Activity) StreamClosed() {
	if a == nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	if a.streams > 0 {
		a.streams--
	}
	a.lastUsed = a.now()
}

// Idle reports whether nothing is using the dashboard and nothing has for the
// idle period.
func (a *Activity) Idle() bool {
	if a == nil {
		return false
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	return a.idleLocked()
}

// Woken receives a value when use returns after an idle period: the first
// request, or the first stream, after Idle was true. It does not receive for
// use while the dashboard was already in use, and a signal nobody has read yet
// is not repeated. A nil Activity returns a channel that never receives.
func (a *Activity) Woken() <-chan struct{} {
	if a == nil {
		return nil
	}

	return a.wake
}

func (a *Activity) idleLocked() bool {
	if a.idleAfter <= 0 || a.streams > 0 {
		return false
	}

	return a.now().Sub(a.lastUsed) >= a.idleAfter
}

func (a *Activity) signalLocked() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}
