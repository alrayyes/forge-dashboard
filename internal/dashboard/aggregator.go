package dashboard

import (
	"context"
	"sync"
	"time"
)

// Aggregator holds the most recently fetched Snapshot and refreshes it in
// the background. Get never blocks on a forge: it always returns whatever
// was last successfully assembled, even if a refresh is running right now
// or every source just failed.
type Aggregator struct {
	sources []Source

	mu   sync.RWMutex
	snap Snapshot

	subsMu sync.Mutex
	subs   map[chan Snapshot]struct{}
}

// NewAggregator returns an Aggregator whose Get answers an empty snapshot
// until the first Refresh (or Run) completes.
func NewAggregator(sources []Source) *Aggregator {
	return &Aggregator{sources: sources, snap: newEmptySnapshot(), subs: make(map[chan Snapshot]struct{})}
}

// Subscribe returns a channel that receives the new Snapshot after every
// completed Refresh, and a function to stop receiving them. The channel is
// buffered by exactly one — a subscriber that falls behind (an SSE client
// whose write is blocked on a slow network) never makes Refresh itself
// block; it just misses an intermediate update and catches up on the next
// one. Call the returned function when done, typically via defer: it
// closes the channel, so a range over it ends cleanly.
func (a *Aggregator) Subscribe() (<-chan Snapshot, func()) {
	ch := make(chan Snapshot, 1)

	a.subsMu.Lock()
	a.subs[ch] = struct{}{}
	a.subsMu.Unlock()

	unsubscribe := func() {
		a.subsMu.Lock()
		if _, ok := a.subs[ch]; ok {
			delete(a.subs, ch)
			close(ch)
		}
		a.subsMu.Unlock()
	}
	return ch, unsubscribe
}

// notify delivers snap to every current subscriber without blocking — see
// Subscribe's doc comment on why a full channel is skipped rather than
// waited on.
func (a *Aggregator) notify(snap Snapshot) {
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	for ch := range a.subs {
		select {
		case ch <- snap:
		default:
		}
	}
}

// Get returns the current snapshot. Safe to call concurrently with Refresh.
func (a *Aggregator) Get() Snapshot {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.snap
}

// Refresh fetches every source concurrently and replaces the snapshot with
// the merged result. A source's own Fetch never returns an error — a forge
// it can't reach at all shows up as an unreachable ForgeHealth entry
// instead, so one broken forge never drops the other's data.
func (a *Aggregator) Refresh(ctx context.Context) {
	results := make([]Result, len(a.sources))

	var wg sync.WaitGroup
	for i, src := range a.sources {
		wg.Add(1)
		go func(i int, src Source) {
			defer wg.Done()
			results[i] = src.Fetch(ctx)
		}(i, src)
	}
	wg.Wait()

	snap := newEmptySnapshot()
	snap.GeneratedAt = time.Now().UTC()
	for _, r := range results {
		snap.Forges = append(snap.Forges, r.Health)
		snap.PullRequests = append(snap.PullRequests, r.PullRequests...)
		snap.Issues = append(snap.Issues, r.Issues...)
	}

	a.mu.Lock()
	a.snap = snap
	a.mu.Unlock()

	a.notify(snap)
}

// Run refreshes immediately, then again every interval, until ctx is
// canceled. Meant to run in its own goroutine for the lifetime of the
// process.
func (a *Aggregator) Run(ctx context.Context, interval time.Duration) {
	a.Refresh(ctx)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.Refresh(ctx)
		}
	}
}
