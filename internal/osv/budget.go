package osv

import (
	"context"
	"sync"
	"time"
)

// budget is a deadline that stands still while its scan waits for a turn at
// the client's shared fetch limit, so a busy client doesn't count against a
// scan that has done nothing slow itself.
type budget struct {
	mu        sync.Mutex
	timer     *time.Timer
	remaining time.Duration
	since     time.Time // when the timer last started; zero while paused
	waiting   int
	cancel    context.CancelCauseFunc
}

type budgetKey struct{}

// WithBudget is context.WithTimeout for a scan against a Client: the time the
// scan spends queued behind the client's shared fetch limit, or behind another
// scan's fetch of the same record, doesn't count. The returned context is
// cancelled with context.DeadlineExceeded as its cause when the budget is used
// up. Call the cancel function when the scan is done.
func WithBudget(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(parent)
	b := &budget{remaining: d, cancel: cancel}
	b.mu.Lock()
	b.start()
	b.mu.Unlock()

	return context.WithValue(ctx, budgetKey{}, b), func() {
		b.mu.Lock()
		b.timer.Stop()
		b.mu.Unlock()
		cancel(context.Canceled)
	}
}

// start runs the timer for what is left. Call it with b.mu held.
func (b *budget) start() {
	b.since = time.Now()
	b.timer = time.AfterFunc(b.remaining, func() { b.cancel(context.DeadlineExceeded) })
}

// wait marks the scan as queued until the returned function is called. The
// clock stops with the first waiter and restarts when the last one is served.
func (b *budget) wait() (done func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.waiting == 0 && b.timer.Stop() {
		b.remaining -= time.Since(b.since)
		b.since = time.Time{}
	}
	b.waiting++

	return func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		b.waiting--
		if b.waiting == 0 && b.since.IsZero() {
			b.start()
		}
	}
}

// queued tells ctx's budget, if it has one, that the caller is queued. The
// returned function ends the wait.
func queued(ctx context.Context) (done func()) {
	if b, ok := ctx.Value(budgetKey{}).(*budget); ok {
		return b.wait()
	}

	return func() {}
}
