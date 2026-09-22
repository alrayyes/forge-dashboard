package dashboard

import (
	"context"
	"log/slog"
	"slices"
	"strings"
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

	// autoUpdate is nil unless EnableAutoUpdateBranch was called — see
	// auto_update_branch.go.
	autoUpdate *autoUpdateBranchConfig
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
		a.mergeRepo(ctx, forge, fullName, prs, issues)
	})

	return true
}

// mergeRepo replaces forge/fullName's own entries in the current snapshot
// with prs and issues, leaving every other repo's data untouched.
func (a *Aggregator) mergeRepo(ctx context.Context, forge Forge, fullName string, prs []PullRequest, issues []Issue) {
	a.mu.Lock()
	current := a.snap
	a.mu.Unlock()

	merged := Snapshot{Forges: current.Forges, Repos: current.Repos, GeneratedAt: time.Now().UTC()}
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
	a.runAutoUpdateBranch(ctx, merged)
}

// sortByRecency orders both slices most-recently-updated first, except
// that a pull request ready to merge right now floats ahead of one
// that isn't — "ready" meaning exactly what mergeActionCell itself
// gates the Merge button on (MergeMergeable and CI resolved, not still
// pending), since a sort criterion that doesn't match what's actually
// clickable would float PRs the reader still can't act on. Recency is
// the tie-breaker within a tier, same as it always was; it never
// overrides readiness. Without the plain recency baseline this began
// as, a snapshot's order was purely an accident of merge order —
// confirmed live: the client's own paginated board (25 items per page)
// never re-sorts either, so whichever repo a scoped refresh had just
// appended to the tail of the list could knock a brand new issue clean
// off page 1, real incident behind #162.
func sortByRecency(prs []PullRequest, issues []Issue) {
	slices.SortFunc(prs, func(a, b PullRequest) int {
		if ar, br := readyToMerge(a), readyToMerge(b); ar != br {
			if ar {
				return -1
			}

			return 1
		}

		return b.UpdatedAt.Compare(a.UpdatedAt)
	})
	slices.SortFunc(issues, func(a, b Issue) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
}

// readyToMerge mirrors +page.svelte's own mergeActionCell gate exactly
// — the same two conditions decide both whether the Merge button shows
// and whether this pull request floats to the top of the list, so the
// two can't silently drift apart.
func readyToMerge(pr PullRequest) bool {
	return pr.MergeStatus == MergeMergeable && pr.CI != CIPending
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
		snap.Repos = append(snap.Repos, r.Repos...)
	}
	sortByRecency(snap.PullRequests, snap.Issues)

	a.mu.Lock()
	previous := a.snap
	a.snap = snap
	a.mu.Unlock()

	logRateLimitTransitions(previous.Forges, snap.Forges)

	a.notify(snap)
	a.runAutoUpdateBranch(ctx, snap)
}

// logRateLimitTransitions logs a rate-limit budget crossing into or out of
// exhaustion between two consecutive refreshes — the per-poll GraphQL
// "cost" line (internal/github/client.go) says how much a poll spent, not
// whether the account just ran out or just got its budget back, and a
// budget silently locking every proactive action (merge, update branch,
// Dependabot/Renovate triggers) until reset deserves a real log line, not
// just the dashboard's own banner (#450). Edge-triggered rather than
// logging on every poll while exhausted, which would just be noise: one
// line when it happens, one when it clears.
func logRateLimitTransitions(previous, current []ForgeHealth) {
	previousByForge := make(map[Forge]ForgeHealth, len(previous))
	for _, h := range previous {
		previousByForge[h.Forge] = h
	}

	for _, cur := range current {
		prev := previousByForge[cur.Forge]
		logOneRateLimitTransition(cur.Forge, "graphql", prev.RateLimitGraphQL, cur.RateLimitGraphQL)
		logOneRateLimitTransition(cur.Forge, "rest", prev.RateLimitREST, cur.RateLimitREST)
	}
}

// logOneRateLimitTransition compares one budget's previous and current
// reading. A nil reading (no data this poll, or the very first one) never
// counts as a transition either way — there's nothing to compare against,
// not a recovery.
func logOneRateLimitTransition(forge Forge, kind string, previous, current *RateLimit) {
	if current == nil {
		return
	}

	wasExhausted := previous != nil && previous.Remaining == 0
	isExhausted := current.Remaining == 0

	switch {
	case isExhausted && !wasExhausted:
		slog.Warn("rate limit exhausted", "forge", forge, "kind", kind, "limit", current.Limit, "resetsAt", current.ResetsAt)
	case wasExhausted && !isExhausted:
		slog.Info("rate limit refreshed", "forge", forge, "kind", kind, "remaining", current.Remaining, "limit", current.Limit)
	}
}

// Run refreshes immediately, then again roughly every interval, until ctx
// is canceled — "roughly" because each cycle's actual delay comes from
// NextRefreshDelay against the snapshot that refresh just produced, so a
// critically low rate-limit budget pushes the next one out past its own
// reset instead of firing on schedule into an already-exhausted quota
// (#381). A plain Timer, not a Ticker, since the delay changes cycle to
// cycle rather than staying fixed. Meant to run in its own goroutine for
// the lifetime of the process.
func (a *Aggregator) Run(ctx context.Context, interval time.Duration) {
	a.Refresh(ctx)

	timer := time.NewTimer(NextRefreshDelay(a.Get(), interval))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			a.Refresh(ctx)
			timer.Reset(NextRefreshDelay(a.Get(), interval))
		}
	}
}

// PollCI refreshes every repo that currently has at least one open
// pull request whose CI is still pending — the only case a check
// finishing could actually change, and the only one worth spending an
// extra scoped fetch on between full Refresh passes. Fills the gap a
// working webhook would otherwise close: confirmed live, twice
// independently, that real Forgejo instances silently drop the
// "status" webhook event from a hook's persisted event list even
// though the create/edit call reports success (#177) — so without
// this, a finished check on Forgejo waits out the full Run interval
// (20 minutes by default) before the dashboard reflects it. Goes
// through RefreshRepo, not a bespoke fetch — same keyed coalescer, so
// a repo a webhook delivery (on forges where it does work, e.g.
// GitHub) already refreshed seconds ago is never refreshed twice for
// the same reason.
func (a *Aggregator) PollCI(ctx context.Context) {
	type repoKey struct {
		forge    Forge
		owner    string
		name     string
		fullName string
	}
	pending := make(map[repoKey]struct{})
	for _, pr := range a.Get().PullRequests {
		if pr.CI != CIPending {
			continue
		}
		owner, name, ok := strings.Cut(pr.Repo, "/")
		if !ok {
			continue
		}
		pending[repoKey{forge: pr.Forge, owner: owner, name: name, fullName: pr.Repo}] = struct{}{}
	}
	for key := range pending {
		a.RefreshRepo(ctx, key.forge, key.owner, key.name, key.fullName)
	}
}

// RunCIPoll runs PollCI on a fixed interval until ctx is cancelled —
// PollCI's own ticker-loop counterpart, the same relationship Run has
// to Refresh. A plain Ticker, unlike Run's rate-limit-aware Timer:
// PollCI's own per-tick cost is already bounded to just the repos with
// something pending, so it doesn't need the same backoff Run's
// account-wide pass does. Meant to run in its own goroutine for the
// lifetime of the process, alongside Run.
func (a *Aggregator) RunCIPoll(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.PollCI(ctx)
		}
	}
}

// criticalRateLimitFraction matches the frontend's own "rl-critical"
// threshold (web/src/routes/(app)/insights/+page.svelte's
// rateLimitStatusClass) — below 5% remaining is critical there too, so
// backoff kicks in at the same point a user would already see the gauge
// turn red.
const criticalRateLimitFraction = 0.05

// backoffBuffer pads past a critically-low budget's own ResetsAt, so the
// next scheduled refresh doesn't fire the instant the window resets and
// race a response that hasn't actually rolled the counter over yet.
const backoffBuffer = 30 * time.Second

// maxBackoff caps how long a single delay can stretch, so a bogus or
// far-future ResetsAt — a skewed forge clock, a zero value from a source
// that doesn't actually report one — can't stall polling indefinitely.
const maxBackoff = time.Hour

// criticallyLow reports whether rl has less than criticalRateLimitFraction
// of its budget left. A nil rl (the forge didn't report one, or made no
// call of that kind this cycle) is never critical — there's nothing to
// back off from.
func criticallyLow(rl *RateLimit) bool {
	return rl != nil && rl.Limit > 0 && float64(rl.Remaining)/float64(rl.Limit) < criticalRateLimitFraction
}

// NextRefreshDelay returns how long to wait before the next scheduled
// refresh, given the snapshot the most recent one just produced. interval
// unchanged unless some forge's REST or GraphQL budget is critically low,
// in which case it delays until that budget's own reset (plus
// backoffBuffer, capped at maxBackoff) instead — never shorter than
// interval, so a stale or already-past ResetsAt can't speed polling up.
// The worse of several critical budgets wins.
func NextRefreshDelay(snap Snapshot, interval time.Duration) time.Duration {
	delay := interval
	now := time.Now()
	for _, f := range snap.Forges {
		for _, rl := range [2]*RateLimit{f.RateLimitGraphQL, f.RateLimitREST} {
			if !criticallyLow(rl) {
				continue
			}
			untilReset := min(rl.ResetsAt.Sub(now)+backoffBuffer, maxBackoff)
			delay = max(delay, untilReset)
		}
	}

	return delay
}
