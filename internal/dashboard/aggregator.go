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
}

// NewAggregator returns an Aggregator whose Get answers an empty snapshot
// until the first Refresh (or Run) completes.
func NewAggregator(sources []Source) *Aggregator {
	return &Aggregator{sources: sources, snap: newEmptySnapshot()}
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
