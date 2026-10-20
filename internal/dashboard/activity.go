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

// PresenceHeartbeat is how often a visible tab tells the server it is still
// being looked at. A hidden tab sends nothing, so the browser's throttling of
// background timers (once a minute at worst) never delays a heartbeat.
const PresenceHeartbeat = time.Minute

// PresenceTTL is how long a tab keeps holding the dashboard active after its
// last heartbeat. Three heartbeats: a missed one or two (a slow network, a
// busy tab) do not let go, while a closed laptop or a crashed browser, which
// can send no "hidden" message and may leave a stream half-open, stops
// counting within a bounded time.
const PresenceTTL = 3 * PresenceHeartbeat

// MaxViewers caps how many tabs are tracked at once. A person has a handful of
// tabs; the cap keeps a client that invents ids from growing the map. Past it
// the tab heard from longest ago is dropped.
const MaxViewers = 32

// Activity records whether anyone is using the dashboard, so the background
// refresh can rest when nobody is. Two things count as use:
//
//   - a request from a signed-in browser or an API client (Touch), and
//   - a tab that is visible and has had input recently, which says so with a
//     heartbeat (Present) and holds the dashboard active until it says it was
//     hidden, or stops sending heartbeats for PresenceTTL.
//
// An open live stream does not count. The server cannot tell a stream in a tab
// someone is looking at from one in a tab nobody is, which is why the page
// reports visibility itself (Page Visibility API) and why the page's own
// background reads, which a hidden tab keeps making, are not use either. The
// stream's keep-alive writes never touch this.
//
// Idle is "no tab is holding it and the last use was at least the idle period
// ago". A process that has only just started is not idle: its start counts as
// use. The zero idle period turns idle mode off.
//
// One Activity serves every Aggregator the Manager builds, and its wake is
// read by whichever Run gets there first. With one signed-in user, which is
// what the app is becoming, that is the only reader. Should several users come
// back, only one of them would catch up at once; the others catch up on their
// next scheduled tick.
//
// A nil *Activity is valid and is never idle, which is what an Aggregator
// built without idle mode holds. Safe for concurrent use.
type Activity struct {
	idleAfter time.Duration
	now       func() time.Time
	wake      chan struct{}

	mu       sync.Mutex
	lastUsed time.Time
	viewers  map[string]time.Time
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
		viewers:   make(map[string]time.Time),
	}
}

// IdleAfter is the idle period, zero when idle mode is off. Safe on nil.
func (a *Activity) IdleAfter() time.Duration {
	if a == nil {
		return 0
	}

	return a.idleAfter
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

// Present records what one tab (viewer) reports. A visible report is use: it
// holds the dashboard active for PresenceTTL and wakes it if it was idle. A
// hidden report lets that tab go and starts the idle period from this moment;
// one from a tab never heard from changes nothing.
func (a *Activity) Present(viewer string, visible bool) {
	if a == nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	now := a.now()
	if !visible {
		if _, known := a.viewers[viewer]; known {
			delete(a.viewers, viewer)
			a.lastUsed = now
		}

		return
	}

	wasIdle := a.idleLocked()
	a.pruneLocked(now)
	if _, known := a.viewers[viewer]; !known && len(a.viewers) >= MaxViewers {
		a.dropOldestLocked()
	}
	a.viewers[viewer] = now
	a.lastUsed = now
	if wasIdle {
		a.signalLocked()
	}
}

// ViewerCount is how many tabs are being tracked, for tests of the cap.
func (a *Activity) ViewerCount() int {
	if a == nil {
		return 0
	}

	a.mu.Lock()
	defer a.mu.Unlock()

	return len(a.viewers)
}

func (a *Activity) pruneLocked(now time.Time) {
	for id, seen := range a.viewers {
		if now.Sub(seen) >= PresenceTTL {
			delete(a.viewers, id)
		}
	}
}

func (a *Activity) dropOldestLocked() {
	var oldest string
	var oldestSeen time.Time
	for id, seen := range a.viewers {
		if oldest == "" || seen.Before(oldestSeen) {
			oldest, oldestSeen = id, seen
		}
	}
	delete(a.viewers, oldest)
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
// request, or the first tab to report itself visible, after Idle was true. It does not receive for
// use while the dashboard was already in use, and a signal nobody has read yet
// is not repeated. A nil Activity returns a channel that never receives.
func (a *Activity) Woken() <-chan struct{} {
	if a == nil {
		return nil
	}

	return a.wake
}

// drainWake discards a wake nobody has read. Safe on nil.
func (a *Activity) drainWake() {
	if a == nil {
		return
	}

	select {
	case <-a.wake:
	default:
	}
}

func (a *Activity) idleLocked() bool {
	if a.idleAfter <= 0 {
		return false
	}

	now := a.now()
	for id, seen := range a.viewers {
		if now.Sub(seen) < PresenceTTL {
			return false
		}
		delete(a.viewers, id)
	}

	return now.Sub(a.lastUsed) >= a.idleAfter
}

func (a *Activity) signalLocked() {
	select {
	case a.wake <- struct{}{}:
	default:
	}
}
