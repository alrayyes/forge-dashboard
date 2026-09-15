package dashboard

import (
	"context"
	"log/slog"
	"slices"
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

	refresh     *coalescer
	repoRefresh *keyedCoalescer
}

// NewAggregator returns an Aggregator whose Get answers an empty snapshot
// until the first Refresh (or Run) completes.
func NewAggregator(sources []Source) *Aggregator {
	return &Aggregator{
		sources:     sources,
		snap:        newEmptySnapshot(),
		subs:        make(map[chan Snapshot]struct{}),
		refresh:     newCoalescer(),
		repoRefresh: newKeyedCoalescer(),
	}
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
// the merged result, and does not return until a pass that started at or
// after this call has completed — see coalescer's doc comment for the
// guarantee and the incident behind it. A source's own Fetch never
// returns an error — a forge it can't reach at all shows up as an
// unreachable ForgeHealth entry instead, so one broken forge never drops
// the other's data.
func (a *Aggregator) Refresh(ctx context.Context) {
	a.refresh.do(func() { a.refreshOnce(ctx) })
}

// RefreshRepo refreshes just the named repository's pull requests and
// issues, merging the result into the current snapshot in place of that
// repo's previous entries rather than replacing the whole snapshot — the
// scoped counterpart to Refresh, for a webhook delivery that already
// knows exactly which repo changed. Reports false if no configured
// Source drives forge, or if the one that does can't do a scoped fetch
// (RepoRefresher, the same optional-capability pattern as RateLimiter) —
// the caller's own signal to fall back to a full Refresh, so a repo
// never silently goes unrefreshed just because its Source can't do this
// yet.
//
// Concurrent calls for the same repo coalesce the same way Refresh's own
// calls do — see coalescer — keyed so an unrelated repo's own refresh
// never waits on this one.
func (a *Aggregator) RefreshRepo(ctx context.Context, forge Forge, owner, name, fullName string) bool {
	var refresher RepoRefresher
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		r, ok := src.(RepoRefresher)
		if !ok {
			return false
		}
		refresher = r
		break
	}
	if refresher == nil {
		return false
	}

	a.repoRefresh.do(string(forge)+"/"+fullName, func() {
		prs, issues, err := refresher.FetchRepo(ctx, owner, name, fullName)
		if err != nil {
			slog.Warn("scoped refresh failed", "forge", forge, "repo", fullName, "error", err)
			return
		}
		a.mergeRepo(forge, fullName, prs, issues)
	})
	return true
}

// mergeRepo replaces forge/fullName's own entries in the current snapshot
// with prs and issues, leaving every other repo's data untouched.
func (a *Aggregator) mergeRepo(forge Forge, fullName string, prs []PullRequest, issues []Issue) {
	a.mu.Lock()
	current := a.snap
	a.mu.Unlock()

	merged := Snapshot{Forges: current.Forges, GeneratedAt: time.Now().UTC()}
	for _, pr := range current.PullRequests {
		if pr.Forge == forge && pr.Repo == fullName {
			continue
		}
		merged.PullRequests = append(merged.PullRequests, pr)
	}
	merged.PullRequests = append(merged.PullRequests, prs...)

	for _, i := range current.Issues {
		if i.Forge == forge && i.Repo == fullName {
			continue
		}
		merged.Issues = append(merged.Issues, i)
	}
	merged.Issues = append(merged.Issues, issues...)
	sortByRecency(merged.PullRequests, merged.Issues)

	a.mu.Lock()
	a.snap = merged
	a.mu.Unlock()

	a.notify(merged)
}

// sortByRecency orders both slices most-recently-updated first. Without
// this, a snapshot's order was purely an accident of merge order —
// confirmed live: the client's own paginated board (25 items per page)
// never re-sorts either, so whichever repo a scoped refresh had just
// appended to the tail of the list could knock a brand new issue clean
// off page 1, real incident behind #162.
func sortByRecency(prs []PullRequest, issues []Issue) {
	slices.SortFunc(prs, func(a, b PullRequest) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	slices.SortFunc(issues, func(a, b Issue) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
}

func (a *Aggregator) refreshOnce(ctx context.Context) {
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
	sortByRecency(snap.PullRequests, snap.Issues)

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
