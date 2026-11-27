package dashboard

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
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

	// scopedSeq is, per repo, the fetchSeq of the newest scoped refresh merged
	// into the snapshot. A full refresh that started before it holds older data
	// for that repo and must not replace the newer (#966). Guarded by mu.
	scopedSeq map[repoKey]uint64

	// fullSeq is, per forge, the fetchSeq of the newest full refresh that read
	// it. A scoped refresh that began before it read the forge before that
	// refresh did, so its rows must not replace the ones the full refresh wrote:
	// a pull request merged in between would come back as open. A forge that
	// was held back, skipped or failed has no entry advanced: nothing was read.
	// unread names the repos that refresh could not read, whose rows are old
	// ones, so a scoped read of them stays welcome.
	fullSeq map[Forge]uint64
	unread  map[repoKey]bool

	// autoUpdate is nil unless EnableAutoUpdateBranch was called — see
	// auto_update_branch.go.
	autoUpdate *autoUpdateBranchConfig

	// autoMerge is nil unless EnableAutoMerge was called — see auto_merge.go.
	autoMerge *autoMergeConfig

	// webhookUpgrade is nil unless EnableWebhookUpgrade was called — see
	// webhook_upgrade.go.
	webhookUpgrade *webhookUpgradeConfig

	// queued is nil unless EnableQueuedActions was called — see
	// queued_runner.go. queuedBuffer is how long past a reset it waits.
	queued       *queuedActionsConfig
	queuedBuffer time.Duration

	// fetchDeadline is how long a refresh waits for the sources before it
	// publishes without the ones still fetching (#3019). fetchAfter schedules
	// it.
	fetchDeadline time.Duration
	fetchAfter    AfterFunc
	// userFetchDeadline is the shorter wait of a refresh a person asked for.
	userFetchDeadline time.Duration
	// fetching marks the sources whose last fetch has not returned yet, by
	// place in sources (#3021).
	fetching []atomic.Bool
	// fetchStarted is when each source's running fetch began, as Unix
	// nanoseconds, so a log line can say how long it has been going (#4977).
	fetchStarted []atomic.Int64
	// flights holds each source's latest fetch, which may outlive its pass,
	// and foldMu serialises whatever puts a fetch's outcome on the board: a
	// refresh and a late read (late_fetch.go). Lock order: foldMu before mu.
	flights []atomic.Pointer[flight]
	foldMu  sync.Mutex
	// writeBudget is how long a refresh waits for the writes that follow it,
	// the auto update-branch and auto-merge passes, before it moves on, and how
	// long a pass may run at all. writeAfter schedules it. writing marks a pass
	// still running, and queuedWrites holds the newest snapshot a refresh
	// brought while it was, for the pass to run when it ends. All three sit
	// under writeMu.
	writeBudget  time.Duration
	writeAfter   AfterFunc
	writeMu      sync.Mutex
	writing      bool
	queuedWrites *queuedWrite
	// pass is the fetch pass in flight, so a person's click that joins a
	// scheduled one can shorten its wait (#3021).
	pass   *fetchPass
	passMu sync.Mutex

	// settled holds pull requests a merge or close just succeeded on (#835),
	// keyed by settledKey. The forge can go on listing one as open for a
	// few seconds, so refreshes keep it off the board until the forge
	// stops listing it or settleWindow passes.
	settledMu    sync.Mutex
	settled      map[string]time.Time
	settleWindow time.Duration

	// botRequests holds the Dependabot and Renovate rebases asked for
	// through this app (#808), keyed by settledKey. fetchSeq numbers fetches
	// as they start, so a request knows which answers came too early to
	// show what it did. Lock order: mu before botMu, never the other way.
	botMu       sync.Mutex
	botRequests map[string]*botEntry
	// boxOverrides holds the Renovate rebase box states this app set itself,
	// under botMu too and keyed the same way.
	boxOverrides map[string]boxOverride
	// updateRequests holds the Update branch requests the forge accepted
	// (#982), under botMu too and keyed the same way.
	updateRequests map[string]*updateEntry
	fetchSeq       atomic.Uint64
	// passes counts the refreshes that fetched since the last full pass, so every
	// fullPassEvery-th one, and the first after a start, is full (see notePass).
	passes atomic.Uint64
	now    func() time.Time
	// after and debounce hold back the scoped refresh a webhook delivery
	// asks for until its burst is over (RefreshRepoDebounced).
	after AfterFunc
	// newRunTimer makes the timer Run waits on; a test supplies its own.
	newRunTimer func(d time.Duration) RunTimer
	debounce    *debouncer
	// debounceOwner, when set, ends the debouncer with the Aggregator's run.
	debounceOwner context.Context
	// webhookMinInterval is the least time between two webhook refreshes of a repo.
	webhookMinInterval time.Duration

	// firstRefreshed flips once, when the first refreshOnce finishes —
	// every source answered or reported itself unreachable — or when Run is
	// cancelled before it starts. Readiness (Service.FirstRefreshComplete)
	// reads it; it never flips back.
	firstRefreshed atomic.Bool
	// firstRefreshedCh is closed with it, for a reader that would rather wait
	// than answer from the empty snapshot (WaitFirstRefresh).
	firstRefreshedCh   chan struct{}
	firstRefreshedOnce sync.Once

	// lastGood is when each forge last fetched successfully, so a failed
	// refresh can carry its data over and say how old it is (#922). Guarded
	// by mu, like snap.
	lastGood map[Forge]time.Time
	// failStreak counts each forge's consecutive failed fetches
	// (ForgeFailureThreshold).
	failStreak map[Forge]int

	// activity says whether anyone is using the dashboard, so Run can rest
	// its scheduled refresh while nobody is. Nil means always in use.
	activity *Activity

	// seen records the last webhook delivery per repo and event class.
	seen webhookSeen

	// snapCache keeps the snapshot across restarts; nil keeps it in memory
	// only. restored is set when the snapshot started from it, so a page
	// has something to show without waiting for the first refresh.
	snapCache SnapshotCache
	// saved is the payload stored for each repo, per forge, so a refresh writes
	// only what differs. savedMu guards it.
	savedMu  sync.Mutex
	saved    map[Forge]map[string][]byte
	restored atomic.Bool
	// seenStore keeps the webhook_seen record across restarts; nil keeps it
	// in memory only.
	seenStore WebhookSeenStore

	// ciBase is the CI poll's base interval in nanoseconds (RunCIPoll sets it,
	// WithCIPollInterval presets it); zero polls every pending pull request on
	// every call.
	ciBase atomic.Int64
	// reserve remembers what background full refreshes cost, for the reserve
	// held back for user actions (reserve.go).
	reserve reserveLedger
	// userRefreshes counts the Refresh calls a person (or a sign-in) is waiting
	// on. A coalesced run executes its leader's closure, so whether a run may
	// be held at the reserve is decided per call from this, not per closure.
	userRefreshes atomic.Int32
	// pendingSched spaces out the polls of pull requests that keep reading the same.
	pendingSched pendingSchedule
}

// WithCIPollInterval sets the base interval PollCI spaces its polls from,
// for a caller that drives PollCI itself rather than through RunCIPoll.
func WithCIPollInterval(d time.Duration) AggregatorOption {
	return func(a *Aggregator) { a.ciBase.Store(int64(d)) }
}

// defaultSettleWindow is how long a pull request a merge or close succeeded
// on stays off the board while the forge still lists it as open. Past it, a
// pull request still listed as open shows again, since something is wrong
// and the user should see it.
const defaultSettleWindow = 2 * time.Minute

// defaultFetchDeadline is how long a refresh waits for every source. Each
// forge call times out on its own after 30 seconds, but one fetch makes many
// calls, so a hung forge could hold the whole snapshot back for far longer.
// Three minutes is well past a slow healthy fetch of a large install; a source
// still fetching then has missed the pass, and its rows are held as it last
// had them (#3019, #4977). A read left running by a person's refresh gets this
// long too (#5059).
const defaultFetchDeadline = 3 * time.Minute

// defaultUserFetchDeadline is how long a refresh a person asked for (the
// Refresh button, a sign-in, a forced refresh) waits for its sources. Someone
// is looking at the board, so it stops waiting for a silent forge sooner than
// the schedule does, and leaves its read running. A minute is twice the
// per-call timeout, and short enough to still feel like the refresh answered
// (#3021, #5059).
const defaultUserFetchDeadline = time.Minute

// defaultWriteBudget is how long a refresh waits for the forge writes that
// follow it: the auto update-branch and auto-merge passes. Each call times out
// on its own after 30 seconds, but a pass makes one call per pull request, so a
// forge that hangs on them could hold every later refresh for minutes. A
// healthy pass is a handful of quick calls; one still running at the budget is
// cut off and the board moves on (#3034).
const defaultWriteBudget = 30 * time.Second

// AggregatorOption configures NewAggregator.
type AggregatorOption func(*Aggregator)

// WithWriteBudget sets how long a refresh waits for its forge writes, and the
// timer it waits with, for tests that drive time by hand.
func WithWriteBudget(d time.Duration, after AfterFunc) AggregatorOption {
	return func(a *Aggregator) { a.writeBudget, a.writeAfter = d, after }
}

// WithSettleWindow sets how long MarkSettled keeps a pull request off the
// board while the forge still lists it.
func WithSettleWindow(d time.Duration) AggregatorOption {
	return func(a *Aggregator) { a.settleWindow = d }
}

// WithFetchDeadline sets how long a refresh waits for its sources, and the
// timer it waits with, for tests that drive time by hand.
func WithFetchDeadline(d time.Duration, after AfterFunc) AggregatorOption {
	return func(a *Aggregator) { a.fetchDeadline, a.fetchAfter = d, after }
}

// WithUserFetchDeadline sets how long a refresh a person asked for waits for
// its sources. WithFetchDeadline still sets the wait of a scheduled one.
func WithUserFetchDeadline(d time.Duration) AggregatorOption {
	return func(a *Aggregator) { a.userFetchDeadline = d }
}

// WithClock sets the clock bot request deadlines read, for tests.
func WithClock(now func() time.Time) AggregatorOption {
	return func(a *Aggregator) { a.now = now }
}

// RunTimer is the timer Run waits on between scheduled refreshes. *time.Timer
// is the real one, wrapped by realRunTimer.
type RunTimer interface {
	C() <-chan time.Time
	Reset(d time.Duration)
	Stop() bool
}

type realRunTimer struct{ *time.Timer }

func (t realRunTimer) C() <-chan time.Time { return t.Timer.C }

func (t realRunTimer) Reset(d time.Duration) { t.Timer.Reset(d) }

// WithRunTimer sets the timer Run waits on, for tests that drive time by hand.
// newTimer is called once, with the first delay.
func WithRunTimer(newTimer func(d time.Duration) RunTimer) AggregatorOption {
	return func(a *Aggregator) { a.newRunTimer = newTimer }
}

// WithActivity makes Run skip its scheduled refresh while act reports the
// dashboard idle, and refresh once when use returns. Refresh and RefreshRepo
// are unaffected: a forced refresh and a webhook delivery run regardless.
func WithActivity(act *Activity) AggregatorOption {
	return func(a *Aggregator) { a.activity = act }
}

// NewAggregator returns an Aggregator whose Get answers an empty snapshot
// until the first Refresh (or Run) completes.
func NewAggregator(sources []Source, opts ...AggregatorOption) *Aggregator {
	a := &Aggregator{
		sources:           sources,
		snap:              newEmptySnapshot(),
		subs:              make(map[chan Snapshot]struct{}),
		refresh:           newCoalescer(),
		repoRefresh:       newKeyedCoalescer(),
		scopedSeq:         make(map[repoKey]uint64),
		fullSeq:           make(map[Forge]uint64),
		unread:            make(map[repoKey]bool),
		settled:           make(map[string]time.Time),
		settleWindow:      defaultSettleWindow,
		botRequests:       make(map[string]*botEntry),
		boxOverrides:      make(map[string]boxOverride),
		updateRequests:    make(map[string]*updateEntry),
		now:               time.Now,
		after:             realAfterFunc,
		newRunTimer:       func(d time.Duration) RunTimer { return realRunTimer{time.NewTimer(d)} },
		lastGood:          make(map[Forge]time.Time),
		queuedBuffer:      backoffBuffer,
		fetchDeadline:     defaultFetchDeadline,
		userFetchDeadline: defaultUserFetchDeadline,
		fetchAfter:        realAfterFunc,
		writeBudget:       defaultWriteBudget,
		writeAfter:        realAfterFunc,
		firstRefreshedCh:  make(chan struct{}),

		webhookMinInterval: DefaultWebhookMinInterval,
	}
	for _, opt := range opts {
		opt(a)
	}
	a.fetching = make([]atomic.Bool, len(a.sources))
	a.fetchStarted = make([]atomic.Int64, len(a.sources))
	a.flights = make([]atomic.Pointer[flight], len(a.sources))
	a.debounce = newDebouncer(a.debounceOwner, a.now, a.after, webhookQuiet, webhookMaxHold, a.webhookMinInterval)
	if a.snapCache != nil {
		a.restoreSnapshot(context.Background())
	}
	if a.seenStore != nil {
		a.restoreWebhookSeen(context.Background())
	}

	return a
}

func settledKey(forge Forge, repo string, number int) string {
	return fmt.Sprintf("%s/%s#%d", forge, repo, number)
}

// MarkSettled records that a merge or close of forge/repo#number just
// succeeded (#835). The pull request leaves the snapshot at once, subscribers
// are told, and later refreshes keep it off the board while the forge still
// lists it as open. The server knows the action worked, so it decides what is
// listed instead of leaving every client to wait for the forge to catch up.
func (a *Aggregator) MarkSettled(forge Forge, repo string, number int) {
	key := settledKey(forge, repo, number)

	a.settledMu.Lock()
	a.settled[key] = time.Now()
	a.settledMu.Unlock()

	a.mu.Lock()
	next := a.snap
	next.PullRequests = slices.DeleteFunc(slices.Clone(a.snap.PullRequests), func(pr PullRequest) bool {
		return settledKey(pr.Forge, pr.Repo, pr.Number) == key
	})
	// A child of the pull request that just left is no longer stacked.
	AnnotateStacks(next.PullRequests)
	a.snap = next
	a.mu.Unlock()

	a.notify(next)
	a.forgetAutoUpdateChoice(key)
}

// forgetAutoUpdateTimeout bounds the delete forgetAutoUpdateChoice makes.
const forgetAutoUpdateTimeout = 5 * time.Second

// forgetAutoUpdateChoice deletes the pull request's own automatic-update
// choice when it merged or closed. Done here, where every close is told to the
// aggregator (a merge or close through this app, a closed delivery, an
// auto-merge), so a pull request that reopens before any refresh saw it gone
// follows its repo again. The background pass still forgets the ones it finds
// gone, which covers a close nobody told it about. A failure is logged and left
// to that pass.
func (a *Aggregator) forgetAutoUpdateChoice(key string) {
	if a.autoUpdate == nil {
		return
	}
	// A local delete, but MarkSettled has no request to inherit a deadline
	// from, and a stuck database must not hold up a merge or a webhook.
	ctx, cancel := context.WithTimeout(context.Background(), forgetAutoUpdateTimeout)
	defer cancel()
	if err := a.autoUpdate.lister.ForgetPullRequestAutoUpdates(ctx, []string{key}); err != nil {
		slog.Warn("could not forget a settled pull request's update choice", "pull_request", key, "error", err)
	}
}

// Unsettle forgets a MarkSettled for forge/repo#number, for a pull request
// that was reopened: the next refresh lists it again instead of holding it
// back. The snapshot itself is left to that refresh.
func (a *Aggregator) Unsettle(forge Forge, repo string, number int) {
	a.settledMu.Lock()
	defer a.settledMu.Unlock()
	delete(a.settled, settledKey(forge, repo, number))
}

// withoutSettled drops from prs every pull request MarkSettled is still
// holding back, and forgets the ones the forge no longer lists or whose
// window has passed. prs is what a fetch just returned: the whole board, or
// with forge set, one forge's, and with repo set too, one repo's, so a partial
// read never forgets another's pull request. Nothing is forgotten for a forge
// with a read left behind.
func (a *Aggregator) withoutSettled(prs []PullRequest, forge Forge, repo string) []PullRequest {
	a.settledMu.Lock()
	defer a.settledMu.Unlock()

	if len(a.settled) == 0 {
		return prs
	}

	listed := make(map[string]struct{}, len(prs))
	for _, pr := range prs {
		listed[settledKey(pr.Forge, pr.Repo, pr.Number)] = struct{}{}
	}
	scope := ""
	switch {
	case repo != "":
		scope = settledKey(forge, repo, 0)
		scope = scope[:strings.LastIndex(scope, "#")+1]
	case forge != "":
		scope = string(forge) + "/"
	}

	for key, at := range a.settled {
		if scope != "" && !strings.HasPrefix(key, scope) || a.readingBehind(key) {
			continue
		}
		if _, still := listed[key]; time.Since(at) > a.settleWindow || !still {
			delete(a.settled, key)
		}
	}

	return slices.DeleteFunc(prs, func(pr PullRequest) bool {
		_, held := a.settled[settledKey(pr.Forge, pr.Repo, pr.Number)]

		return held
	})
}

// FirstRefreshDone reports whether nothing is left to wait for from the first
// Refresh. Normally it has completed, with every source's result or its
// unreachable ForgeHealth entry in the snapshot. A forge that failed still
// counts: done means "tried", not "succeeded". It is also true for an
// Aggregator whose Run was cancelled before it started: no first refresh is
// coming, and the snapshot has nothing from one.
func (a *Aggregator) FirstRefreshDone() bool { return a.firstRefreshed.Load() }

// WaitFirstRefresh blocks until the first refresh has completed, ctx is done or
// max passes, whichever comes first. A snapshot read before that is the empty
// one, which a page shows as "no pull requests" until the fetch lands (#1194).
func (a *Aggregator) WaitFirstRefresh(ctx context.Context, limit time.Duration) {
	if a.restored.Load() {
		// The saved snapshot, marked stale, is already something to show.
		return
	}
	timer := time.NewTimer(limit)
	defer timer.Stop()
	select {
	case <-a.firstRefreshedCh:
	case <-ctx.Done():
	case <-timer.C:
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
// Subscribe's doc comment on why a full channel is never waited on. A
// subscriber that has not read the previous snapshot yet has it replaced:
// what it needs is the newest state, and keeping the stale one instead left a
// merged pull request on a stream client's board until the next refresh
// (#966). subsMu serialises senders, so the send after the drain finds room.
func (a *Aggregator) notify(snap Snapshot) {
	a.subsMu.Lock()
	defer a.subsMu.Unlock()
	for ch := range a.subs {
		select {
		case <-ch:
		default:
		}
		select {
		case ch <- snap:
		default:
		}
	}
}

// Republish tells every subscriber the current snapshot again, for a change a
// client reads next to it that the snapshot itself doesn't hold, like a queued
// action (#756).
func (a *Aggregator) Republish() { a.notify(a.Get()) }

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
	if !background(ctx) {
		// Counted before it queues, so a run already in flight that this call
		// ends up waiting on still treats it as the person's refresh.
		a.userRefreshes.Add(1)
		defer a.userRefreshes.Add(-1)
		a.joinPass()
	}
	a.refresh.do(func() { a.refreshOnce(apistats.WithKind(ctx, apistats.KindFull)) })
}

// backgroundKey marks a context whose refresh nobody asked for, so it leaves the
// reserve for user actions alone.
type backgroundKey struct{}

func background(ctx context.Context) bool {
	v, _ := ctx.Value(backgroundKey{}).(bool)

	return v
}

// refreshBackground is Refresh for the schedule: it holds back from a forge
// whose budget is at its reserve, which Refresh (a force refresh, a sign-in)
// does not.
func (a *Aggregator) refreshBackground(ctx context.Context) {
	a.Refresh(context.WithValue(ctx, backgroundKey{}, true))
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
//
// attrs are slog key/value pairs added to the "scoped refresh failed" line, so
// a caller that knows why it refreshed (a webhook delivery's id and pull
// request number) can have the failure say so (#966).
func (a *Aggregator) RefreshRepo(ctx context.Context, forge Forge, owner, name, fullName string, attrs ...any) bool {
	refresher := a.repoRefresherFor(forge)
	if refresher == nil {
		return false
	}
	if _, held := a.scopedHold(ctx, forge, owner, name); held {
		// What is left is for the person clicking. Reporting the refresh as
		// run keeps the caller from falling back to a full one, which costs
		// more; the next full refresh picks the change up.
		return true
	}
	a.fetchRepo(ctx, refresher, forge, owner, name, fullName, nil, attrs...)

	return true
}

// scopedHold is holdFor for a one-repo refresh that a webhook asks for. One a
// poll asks for has been checked by the poll already.
func (a *Aggregator) scopedHold(ctx context.Context, forge Forge, owner, name string) (time.Time, bool) {
	if kind := apistats.KindFrom(ctx); kind != apistats.KindUnknown && kind != apistats.KindScopedWebhook {
		return time.Time{}, false
	}

	return a.holdFor(a.Get(), forge, owner, name, apistats.KindScopedWebhook)
}

// The ranks of the callers sharing one repo's fetch. One fetch serves them all,
// so it is made for the highest: a webhook's is paced, and a poll or a person
// waiting with it must not be held back or have its read charged to that share.
const (
	rankWebhook = iota + 1
	rankOther
)

// fetchRepo reads one repo and merges it, whatever the budgets say. A webhook's
// read that the repo's share of the budget doesn't allow yet is left to later,
// which runs once it does. A nil later reads regardless.
func (a *Aggregator) fetchRepo(ctx context.Context, refresher RepoRefresher, forge Forge, owner, name, fullName string, later func(), attrs ...any) {
	key := string(forge) + "/" + fullName
	scoped := scopedRefreshContext(ctx, fullName)
	webhook := apistats.KindFrom(scoped) == apistats.KindScopedWebhook
	rank := rankOther
	if webhook {
		rank = rankWebhook
	}
	a.repoRefresh.doRanked(key, rank, func() {
		// Asked here, not only when the delivery came due: it may have waited
		// behind a run whose cost wasn't known yet.
		if until, held := a.debounce.heldUntil(key); held && webhook && later != nil {
			a.debounce.deferUntil(ctx, key, until, later)

			return
		}
		started := a.now()
		tallied, tally := apistats.WithTally(scoped)
		seq := a.fetchSeq.Add(1)
		var branch *MainBranch
		var branchOK bool
		prs, issues, err := refresher.FetchRepo(tallied, owner, name, fullName)
		if err == nil {
			branch, branchOK = a.fetchMainBranch(tallied, refresher, forge, owner, name, fullName)
		}
		// Charged for the read alone, failed or not, before the merge goes on
		// to work that isn't this repository's.
		if webhook {
			a.chargeWebhook(forge, owner, name, key, started, tally.Spent().GraphQL)
		}
		if err != nil {
			slog.Warn("scoped refresh failed", append([]any{"forge", forge, "repo", fullName, "error", err}, attrs...)...)

			return
		}
		a.mergeRepo(scoped, forge, fullName, seq, prs, issues, branch, branchOK)
	})
}

// mergedSince reports whether a scoped refresh of forge/fullName has been merged
// whose fetch began after the sequence number since.
func (a *Aggregator) mergedSince(forge Forge, fullName string, since uint64) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()

	return a.scopedSeq[repoKey{forge, fullName}] > since
}

// scopedRefreshContext tags a one-repo fetch with the repo, and with a webhook
// as its cause unless the caller already named one (the CI poll does).
func scopedRefreshContext(ctx context.Context, fullName string) context.Context {
	if apistats.KindFrom(ctx) == apistats.KindUnknown {
		ctx = apistats.WithKind(ctx, apistats.KindScopedWebhook)
	}

	return apistats.WithRepo(ctx, fullName)
}

// repoRefresherFor is the Source that drives forge when it can fetch one repo
// on its own, or nil when no Source drives forge or the one that does can't.
func (a *Aggregator) repoRefresherFor(forge Forge) RepoRefresher {
	for _, src := range a.sources {
		if src.Forge() != forge {
			continue
		}
		r, ok := src.(RepoRefresher)
		if !ok {
			return nil
		}

		return r
	}

	return nil
}

// fetchMainBranch re-reads fullName's default branch when the source can, or
// returns nil, which leaves the row as it was. A failed read is logged and also
// leaves it, so one flaky call never blanks the row. The bool is false only for
// a failed read: a source that never reads the branch has nothing to be stale
// about.
func (a *Aggregator) fetchMainBranch(ctx context.Context, src RepoRefresher, forge Forge, owner, name, fullName string) (*MainBranch, bool) {
	refresher, ok := src.(MainBranchRefresher)
	if !ok {
		return nil, true
	}
	branch, err := refresher.FetchMainBranch(ctx, owner, name, fullName)
	if err != nil {
		slog.Warn("scoped default branch refresh failed", "forge", forge, "repo", fullName, "error", err)

		return nil, false
	}

	return &branch, true
}

// mergeRepo replaces forge/fullName's own entries in the current snapshot
// with prs and issues, leaving every other repo's data untouched.
//
// It reads the snapshot, merges and writes it back under one hold of mu. Two
// scoped refreshes of different repos run side by side, and a read taken
// before the lock was released let the later write drop the earlier one's
// repo (#966).
//
// branchOK is false when the branch read failed: the repo's stale mark then
// stays, since the branch row is still the old one.
func (a *Aggregator) mergeRepo(ctx context.Context, forge Forge, fullName string, seq uint64, prs []PullRequest, issues []Issue, branch *MainBranch, branchOK bool) {
	a.mergeReposFrom(ctx, forge, seq, []repoRows{{fullName: fullName, branch: branch, rows: func(Snapshot) ([]PullRequest, []Issue, bool) {
		return prs, issues, true
	}, fetched: branchOK}})
}

// repoRows is one repo's share of a merge: its main branch row, if any, and the
// rows to write in place of its own.
type repoRows struct {
	fullName string
	branch   *MainBranch
	rows     func(current Snapshot) ([]PullRequest, []Issue, bool)
	// fetched is true when rows came from a fetch of the repo's pull requests,
	// its issues and, where it reads one, its main branch, which is what a stale
	// mark is about. A merge that re-feeds the snapshot's own issues leaves the
	// mark alone.
	fetched bool
	// read says which pull requests rows read from the forge; the rest were
	// carried over from the snapshot. The zero value means all.
	read readRows
}

// mergeReposFrom merges several repos of one forge at once: every
// repo is merged into the snapshot under one hold of mu, and the subscribers are
// told and the after-merge sweeps run once for the lot, not once per repo.
func (a *Aggregator) mergeReposFrom(ctx context.Context, forge Forge, seq uint64, repos []repoRows) {
	a.checkDependabotAcks(ctx)

	a.mu.Lock()
	merged := a.snap
	wrote := false
	var fetched map[string]bool
	olderThanFull := seq < a.fullSeq[forge]
	for _, r := range repos {
		if olderThanFull && !a.unread[repoKey{forge, r.fullName}] {
			slog.Debug("scoped refresh dropped, a full refresh read the forge after it began", "forge", forge, "repo", r.fullName, "seq", seq, "full_seq", a.fullSeq[forge])

			continue
		}
		prs, issues, ok := r.rows(merged)
		if !ok {
			continue
		}
		merged = a.mergedRepo(merged, forge, r.fullName, seq, r.branch, prs, issues, r.read)
		if r.fetched {
			if fetched == nil {
				fetched = make(map[string]bool, len(repos))
			}
			fetched[r.fullName] = true
		}
		wrote = true
	}
	if !wrote {
		a.mu.Unlock()

		return
	}
	merged.Repos = withoutStale(merged.Repos, forge, fetched)
	forges, changed := clearMarkWhenFresh(merged.Forges, merged.Repos, forge)
	if changed {
		// Every repo on show is current as of now, so the next failed full
		// refresh carries them over as read now, not at the last full read.
		a.lastGood[forge] = time.Now().UTC()
	}
	merged.Forges = forges
	a.snap = merged
	a.mu.Unlock()

	a.notify(merged)
	a.runWrites(ctx, merged)
}

// queuedWrite is the newest snapshot waiting for the running pass to end. It
// keeps the context of the refresh that brought it, so the pass it gets runs
// under that refresh's values and not the ones of the pass that was in the
// way, and counts how many snapshots it stands in for.
type queuedWrite struct {
	snap Snapshot
	ctx  context.Context //nolint:containedctx // carried to the pass this snapshot waits for
	n    int
}

// runWrites runs the auto update-branch and auto-merge passes against snap and
// waits for them at most writeBudget. A forge that hangs on a write would
// otherwise hold the single-flight refresh, and with it every later one (#3034).
//
// Past the budget the passes' context is cancelled, so the call in flight
// returns and the refresh moves on; the passes stop there, and only the pull
// request whose call was in flight keeps its back-off. One pass runs at a time.
// A snapshot that arrives while one is running, a scoped refresh's "CI passed,
// merge now" included, waits for it to end and then gets a pass of its own with
// a budget of its own. Only the newest waiting snapshot is kept, since it holds
// everything an older one did.
func (a *Aggregator) runWrites(ctx context.Context, snap Snapshot) {
	a.writeMu.Lock()
	if a.writing {
		n := 1
		if a.queuedWrites != nil {
			n += a.queuedWrites.n
		}
		a.queuedWrites = &queuedWrite{snap: snap, ctx: ctx, n: n}
		a.writeMu.Unlock()
		slog.Debug("forge writes are still running, the next pass waits for them")

		return
	}
	a.writing = true
	a.writeMu.Unlock()

	done, expired, cancel := a.startWrites(ctx, snap)
	select {
	case <-done:
	case <-expired:
		slog.Warn("forge writes ran past their budget, moving on", slog.Duration("budget", a.writeBudget))
	case <-ctx.Done():
		cancel()
	}
}

// startWrites runs one pass in a goroutine of its own, on a context that
// outlives ctx's cancellation so a pass queued behind it isn't born dead. The
// budget timer cancels that context and closes expired; done closes once the
// pass has ended and handed over to a queued one, if any. The goroutine ends
// when the calls in flight return, which cancelling makes a real HTTP call do.
func (a *Aggregator) startWrites(ctx context.Context, snap Snapshot) (done, expired <-chan struct{}, cancel context.CancelFunc) {
	wctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	d := make(chan struct{})
	e := make(chan struct{})
	stop := a.writeAfter(a.writeBudget, func() {
		cancel()
		close(e)
	})

	go func() {
		a.runAutoUpdateBranch(wctx, snap)
		a.runAutoMerge(wctx, snap)
		stop()
		cancel()
		a.finishWrites()
		close(d)
	}()

	return d, e, cancel
}

// finishWrites ends a pass: it starts the queued one, if a refresh left one,
// and otherwise frees the slot. Snapshots that waited are one warning, since
// they only pile up when a pass ran long.
func (a *Aggregator) finishWrites() {
	a.writeMu.Lock()
	queued := a.queuedWrites
	a.queuedWrites = nil
	if queued == nil {
		a.writing = false
	}
	a.writeMu.Unlock()

	if queued != nil {
		slog.Warn("forge writes queued behind a running pass now run", "snapshots", queued.n)
		a.startWrites(queued.ctx, queued.snap)
	}
}

// mergedRepo is current with forge/fullName's own entries replaced by prs and
// issues. The caller holds mu and writes the result back.
func (a *Aggregator) mergedRepo(current Snapshot, forge Forge, fullName string, seq uint64, branch *MainBranch, prs []PullRequest, issues []Issue, read readRows) Snapshot {
	merged := Snapshot{Forges: current.Forges, Repos: current.Repos, MainBranches: withMainBranch(current.MainBranches, forge, fullName, branch), GeneratedAt: time.Now().UTC()}
	for _, pr := range current.PullRequests {
		if pr.Forge == forge && pr.Repo == fullName {
			continue
		}
		merged.PullRequests = append(merged.PullRequests, pr)
	}
	merged.PullRequests = append(merged.PullRequests, a.withoutSettled(prs, forge, fullName)...)

	for _, i := range current.Issues {
		if i.Forge == forge && i.Repo == fullName {
			continue
		}
		merged.Issues = append(merged.Issues, i)
	}
	merged.Issues = append(merged.Issues, issues...)
	covers := func(f Forge, repo string) bool { return f == forge && repo == fullName }
	a.settleBoxOverrides(merged.PullRequests, seq, covers, read)
	a.applyBotRequests(merged.PullRequests, seq, covers)
	AnnotateStacks(merged.PullRequests)
	sortByRecency(merged.PullRequests, merged.Issues)

	// A request recorded since applyBotRequests ran lives only in the registry
	// and on the snapshot RecordBotRequest saw, which this one is about to
	// replace. Annotating again under the lock that RecordBotRequest also
	// holds leaves no gap between the two (#976).
	a.annotateBotRequests(merged.PullRequests)
	a.scopedSeq[repoKey{forge, fullName}] = seq

	return merged
}

// withMainBranch is rows with forge/fullName's row replaced by branch, or rows
// itself when branch is nil. It never edits rows in place: a reader may hold it.
func withMainBranch(rows []MainBranch, forge Forge, fullName string, branch *MainBranch) []MainBranch {
	if branch == nil {
		return rows
	}
	out := make([]MainBranch, 0, len(rows)+1)
	replaced := false
	for _, r := range rows {
		if r.Forge == forge && r.FullName == fullName {
			out = append(out, *branch)
			replaced = true

			continue
		}
		out = append(out, r)
	}
	if !replaced {
		out = append(out, *branch)
	}

	return out
}

// sortByRecency orders both slices most-recently-updated first, the order the
// Sort control's Last activity default promises (#1532). Readiness plays no
// part: #536 floated ready-to-merge pull requests above newer ones, which made
// the label untrue, and the Ready quick filter (IsReadyToMerge) finds them now.
// Without a sort at all, a snapshot's order was purely an accident of merge
// order: the client's own paginated board (25 items per page) never re-sorts
// either, so whichever repo a scoped refresh had just appended to the tail of
// the list could knock a brand new issue clean off page 1, the real incident
// behind #162.
func sortByRecency(prs []PullRequest, issues []Issue) {
	slices.SortFunc(prs, func(a, b PullRequest) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
	slices.SortFunc(issues, func(a, b Issue) int { return b.UpdatedAt.Compare(a.UpdatedAt) })
}

// sourceResult is what a source answered, and whether the answer came from
// asking it. The answer of a source that was not asked is the snapshot's rows
// carried over, which no fetch read.
type sourceResult struct {
	Result

	asked bool
	// missed is set when the source gave no answer in time: the pass hit its
	// deadline, or skipped it because the last fetch was still running. It is
	// a slow forge, not a failed one, and counts toward ForgeFailureThreshold.
	missed bool
	// late is set, and the rest is empty, when the source's read is still
	// running behind the pass.
	late *flight
}

// fetchSources asks every source for its data at once and answers in the
// order of a.sources. Each answer says whether its source was asked: the
// others were answered from the snapshot.
func (a *Aggregator) fetchSources(ctx context.Context, seq uint64) []sourceResult {
	results := make([]sourceResult, len(a.sources))

	a.mu.RLock()
	earlier := a.snap
	a.mu.RUnlock()

	// Buffered for every source, so a fetch that answers after the deadline
	// finds room and its goroutine ends.
	answers := make(chan sourceAnswer, len(a.sources))
	pending := map[int]*flight{}
	fetched := false
	// Started before any fetch, so a deadline cannot pass unseen.
	pass, deadline, endPass := a.beginPass(ctx)
	defer endPass()
	for i, src := range a.sources {
		if last := a.flights[i].Load(); last != nil && last.in(flightLeft) {
			// Still within the scheduled deadline: slow, not silent.
			results[i] = sourceResult{late: last}
			slog.Warn("fetch skipped, the last one is still running", "forge", src.Forge(), "path", "skipped", "running_for", a.fetchAge(i))

			continue
		}
		if health, ok := exhaustedHealth(earlier, src.Forge(), a.now()); ok {
			// No budget left until the reset: a call would only fail, and
			// the attempt itself counts against the forge (#755). Keep the
			// last rows and the exhausted budget, so the banner holds.
			results[i].Result = carryOver(Result{Health: notSlow(health)}, earlier, src.Forge())

			continue
		}
		if background(ctx) && a.userRefreshes.Load() == 0 {
			if left, held := a.leftAtReserve(earlier, src.Forge()); held {
				results[i].Result = left

				continue
			}
		}
		if !a.fetching[i].CompareAndSwap(false, true) {
			// The last fetch is still running. Asking again would only add
			// load to a forge that is struggling (#3021).
			results[i] = sourceResult{Health: a.unreachableFrom(earlier, i), missed: true}
			slog.Warn("fetch skipped, the last one is still running", "forge", src.Forge(), "path", "skipped", "running_for", a.fetchAge(i))

			continue
		}
		fetched = true
		fetchCtx, cancel := context.WithCancel(ctx)
		f := &flight{i: i, seq: seq, cancel: cancel}
		defer f.release()
		pending[i] = f
		a.flights[i].Store(f)
		a.fetchStarted[i].Store(a.now().UnixNano())
		go a.fetchOne(ctx, fetchCtx, f, src, answers)
	}
	a.collectAnswers(ctx, results, pending, answers, pass, deadline, earlier)
	a.notePass(ctx, fetched)
	a.noteSpend(results)

	return results
}

// beginPass starts the wait that ends a pass over the sources and makes the
// pass visible to joinPass. It returns the pass, the wait it was given, and the
// function that ends the pass.
func (a *Aggregator) beginPass(ctx context.Context) (*fetchPass, time.Duration, func()) {
	fp := &fetchPass{timedOut: make(chan struct{}), started: a.now()}
	a.passMu.Lock()
	a.pass = fp
	a.passMu.Unlock()
	// Read after the pass is visible to joinPass, so a click is either seen
	// here or finds the pass there.
	deadline := a.userFetchDeadline
	if background(ctx) && a.userRefreshes.Load() == 0 {
		deadline = a.fetchDeadline
	}
	// Armed before any fetch, so a deadline cannot pass unseen.
	fp.arm(a.fetchAfter, deadline, deadline < a.fetchDeadline)

	return fp, deadline, func() {
		a.passMu.Lock()
		a.pass = nil
		a.passMu.Unlock()
		fp.stopTimers()
	}
}

// fetchOne asks f's source and sends its answer. The in-flight mark clears
// whether or not the refresh still listens, and even if Fetch exits its
// goroutine. An answer to a read the pass left behind is applied here, on ctx,
// the pass's own context; one to a read given up on is dropped.
func (a *Aggregator) fetchOne(ctx, fetchCtx context.Context, f *flight, src Source, answers chan<- sourceAnswer) {
	var res Result
	func() {
		defer a.fetching[f.i].Store(false)
		res = src.Fetch(fetchCtx)
	}()
	a.logFetchOutcome(!f.in(flightWaited) || fetchCtx.Err() != nil, f.i, src.Forge(), res)
	if f.deliver(answers, res) == flightLeft {
		f.cancel()
		a.applyLate(ctx, f, sourceResult{Result: res, asked: true})
	}
}

// fetchAge is how long source i's running fetch has been going.
func (a *Aggregator) fetchAge(i int) time.Duration {
	return a.now().Sub(time.Unix(0, a.fetchStarted[i].Load()))
}

// logFetchOutcome says how long a fetch took and how it ended, so a forge
// shown as unreachable can be told from one that answered slowly (#4977). A
// fetch that returns after its pass stopped waiting ("late") is a Warn, as is
// a failure; a good answer is Debug. It logs the error kind, never the text.
func (a *Aggregator) logFetchOutcome(late bool, i int, forge Forge, res Result) {
	took := a.fetchAge(i)
	switch {
	case late:
		slog.Warn("fetch finished", "forge", forge, "duration", took, "outcome", "late")
	case !res.Health.Reachable:
		slog.Warn("fetch finished", "forge", forge, "duration", took, "outcome", "error", "path", "error", "error_kind", res.Health.ErrorKind)
	default:
		slog.Debug("fetch finished", "forge", forge, "duration", took, "outcome", "ok")
	}
}

// sourceAnswer is one source's fetch result, by its place in a.sources.
type sourceAnswer struct {
	i   int
	res Result
}

// collectAnswers fills results from answers until every source in pending has
// answered or the pass's wait ends. A wait shorter than the scheduled deadline
// leaves the reads still pending to run on (#5059). Otherwise such a source gets
// an unreachable result, so the aggregator shows the rows it last had, marked
// stale (#3019).
func (a *Aggregator) collectAnswers(ctx context.Context, results []sourceResult, pending map[int]*flight, answers <-chan sourceAnswer, pass *fetchPass, deadline time.Duration, earlier Snapshot) {
	for len(pending) > 0 {
		select {
		case ans := <-answers:
			takeAnswer(results, pending, ans)
		case <-pass.timedOut:
			// Marked before the drain, so no answer can land after it.
			for _, f := range pending {
				f.stopWaiting(pass.early)
			}
			drainAnswers(results, pending, answers)
			for i, f := range pending {
				if pass.early {
					results[i] = a.leaveRunning(ctx, f, pass.started, deadline)
				} else {
					results[i] = a.giveUp(f, deadline, earlier)
				}
			}

			return
		}
	}
}

func takeAnswer(results []sourceResult, pending map[int]*flight, ans sourceAnswer) {
	results[ans.i] = sourceResult{Result: ans.res, asked: true}
	delete(pending, ans.i)
}

// drainAnswers takes the answers that arrived with the deadline, which still
// count.
func drainAnswers(results []sourceResult, pending map[int]*flight, answers <-chan sourceAnswer) {
	for {
		select {
		case ans := <-answers:
			takeAnswer(results, pending, ans)
		default:
			return
		}
	}
}

// leaveRunning is the result for a read the pass stops waiting for while it
// goes on.
func (a *Aggregator) leaveRunning(ctx context.Context, f *flight, started time.Time, waited time.Duration) sourceResult {
	slog.Info("stopped waiting for a fetch, which goes on", "forge", a.sources[f.i].Forge(), "path", "waiting", "running_for", a.fetchAge(f.i), "deadline", waited)
	a.leave(ctx, f, started)

	return sourceResult{late: f}
}

// giveUp cancels a read still pending at the scheduled deadline and is the
// missed result for it.
func (a *Aggregator) giveUp(f *flight, deadline time.Duration, earlier Snapshot) sourceResult {
	f.cancel()
	slog.Warn("fetch deadline passed with the forge still fetching", "forge", a.sources[f.i].Forge(), "path", "deadline", "running_for", a.fetchAge(f.i), "deadline", deadline)

	return sourceResult{Health: a.unreachableFrom(earlier, f.i), asked: true, missed: true}
}

// unreachableFrom is source i's health from snap, marked unreachable, so its
// rate limits still show.
func (a *Aggregator) unreachableFrom(snap Snapshot, i int) ForgeHealth {
	forge := a.sources[i].Forge()
	h, _ := healthOf(snap, forge)
	h.Forge = forge

	return markUnreachable(h)
}

// markUnreachable is h for a forge that did not answer, so the aggregator
// keeps the rows it last had, marked stale. The rest of h, such as its rate
// limits, is left as it was. A forge still Starting is returned unchanged: its
// first fetch has not answered, so it is starting up, not down, until
// endStarting says otherwise.
func markUnreachable(h ForgeHealth) ForgeHealth {
	if h.Starting {
		return h
	}
	kind := ForgeErrorUnreachable
	h.Reachable = false
	h.Error = HumanizeForgeError(kind)
	h.ErrorKind = kind
	h.Cause = ""
	h.RowsReadAt = nil

	return h
}

// fetchPass is one pass over the sources and the wait that ends it. Its timers
// all close timedOut, so whichever comes first ends the wait.
type fetchPass struct {
	timedOut chan struct{}
	started  time.Time
	once     sync.Once
	// early says the wait that ended was shorter than the scheduled deadline.
	// Read it after timedOut closes.
	early bool

	mu    sync.Mutex
	stops []func() bool
	user  bool
	ended bool
}

func (p *fetchPass) fire(early bool) {
	p.once.Do(func() {
		p.early = early
		close(p.timedOut)
	})
}

func (p *fetchPass) arm(after AfterFunc, d time.Duration, early bool) {
	stop := after(d, func() { p.fire(early) })
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ended {
		stop()

		return
	}
	p.stops = append(p.stops, stop)
}

func (p *fetchPass) stopTimers() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.ended = true
	for _, stop := range p.stops {
		stop()
	}
}

// joinPass is for a person's refresh that may land on a pass already waiting
// out the schedule's longer deadline. It adds the user deadline, counted from
// when the pass began, so the click does not wait out the rest of the three
// minutes on a forge that is not answering (#3021).
func (a *Aggregator) joinPass() {
	a.passMu.Lock()
	fp := a.pass
	a.passMu.Unlock()
	if fp == nil {
		return
	}
	fp.mu.Lock()
	first := !fp.user
	fp.user = true
	fp.mu.Unlock()
	if !first {
		return
	}
	fp.arm(a.fetchAfter, max(a.userFetchDeadline-a.now().Sub(fp.started), 0), a.userFetchDeadline < a.fetchDeadline)
}

// notSlow is h without ForgeCauseSlow and its RowsReadAt, which are about the latest pass only: a
// pass that does not ask the forge must not inherit it. ForgeCauseStarting
// stays, since nothing has answered yet, and so does a forge never read.
func notSlow(h ForgeHealth) ForgeHealth {
	if h.Cause == ForgeCauseSlow && !h.NeverRead() {
		h.Cause = ""
		h.RowsReadAt = nil
	}

	return h
}

// exhaustedHealth returns forge's health from snap when one of its budgets is
// spent and its reset is still ahead, so a fetch before then cannot work.
func exhaustedHealth(snap Snapshot, forge Forge, now time.Time) (ForgeHealth, bool) {
	for _, h := range snap.Forges {
		if h.Forge != forge {
			continue
		}
		for _, rl := range [2]*RateLimit{h.RateLimitGraphQL, h.RateLimitREST} {
			if rl != nil && rl.Limit > 0 && rl.Remaining == 0 && rl.ResetsAt.After(now) {
				return h, true
			}
		}
	}

	return ForgeHealth{}, false
}

func (a *Aggregator) refreshOnce(ctx context.Context) {
	seq := a.fetchSeq.Add(1)
	results := a.fetchSources(a.refreshContext(ctx), seq)
	// It asks the forge, so it stays outside foldMu: a hang holds up no one else.
	a.checkDependabotAcks(ctx)

	a.foldMu.Lock()
	a.mu.RLock()
	earlier := a.snap
	goodAt := maps.Clone(a.lastGood)
	streaks := cloneStreaks(a.failStreak)
	a.mu.RUnlock()

	read := rowsRead(results)
	readForges := make(map[Forge]bool)
	unread := make(map[repoKey]bool)
	snap, notRead := a.assemble(ctx, results, earlier, goodAt, streaks, readForges, unread)
	reachable := reachableForges(snap.Forges)
	for _, forge := range notRead {
		delete(reachable, forge)
	}

	a.mu.Lock()
	previous := a.snap
	// Under mu, so a MarkSettled is either seen here or runs on the new board.
	snap.PullRequests = a.withoutSettled(snap.PullRequests, "", "")
	a.applyBotRequests(snap.PullRequests, seq, func(f Forge, _ string) bool { return reachable[f] })
	AnnotateStacks(snap.PullRequests)
	sortByRecency(snap.PullRequests, snap.Issues)
	snap = a.keepNewerScopedRepos(snap, previous, seq)
	// Rows keepNewerScopedRepos brought back get their requests here (#976).
	// The box overrides are settled here too, under the lock every tick and
	// cancel takes, so none can land between the settling and the swap.
	a.annotateUnderLock(snap.PullRequests, seq, func(f Forge, _ string) bool { return reachable[f] }, read)
	a.snap = snap
	a.noteFullRead(seq, readForges, unread)
	// Not an assignment: goodAt was copied before the compute, and a scoped
	// refresh since may have set a later time (#4108).
	a.keepLaterGood(goodAt)
	a.failStreak = streaks
	a.mu.Unlock()
	a.foldMu.Unlock()
	a.markFirstRefreshed()

	logRateLimitTransitions(previous.Forges, snap.Forges)

	a.publish(ctx, snap)
	a.runWrites(ctx, snap)
	a.startWebhookUpgrade(snap)
}

// assemble is the snapshot a full refresh's results make, before the board's own
// marks go on it. notRead names the forges whose read is still running, which
// say nothing new about their pull requests.
func (a *Aggregator) assemble(ctx context.Context, results []sourceResult, earlier Snapshot, goodAt map[Forge]time.Time, streaks map[Forge]int, readForges map[Forge]bool, unread map[repoKey]bool) (snap Snapshot, notRead []Forge) {
	snap = newEmptySnapshot()
	snap.GeneratedAt = time.Now().UTC()
	for i, sr := range results {
		r := sr.Result
		forge := a.sources[i].Forge()
		logFailedRefresh(sr, forge)
		if sr.late != nil {
			r = heldWhileReading(sr.late.behind.Load(), earlier, goodAt, forge)
			notRead = append(notRead, forge)
		} else {
			r = settleOrHold(r, sr.asked, sr.missed, earlier, goodAt, streaks, snap.GeneratedAt, readForges, unread, forge)
		}
		noteBlockedActions(&r.Health, a.sources[i])
		noteProviderStatus(ctx, &r.Health, a.sources[i])
		snap.add(r)
	}

	return snap, notRead
}

// keepLaterGood folds good into lastGood, per forge, keeping the later time.
// Callers hold mu.
func (a *Aggregator) keepLaterGood(good map[Forge]time.Time) {
	for forge, at := range good {
		if at.After(a.lastGood[forge]) {
			a.lastGood[forge] = at
		}
	}
}

// logFailedRefresh names the cause of a full refresh that asked forge and got no
// answer, so a report of old rows can be traced from the log (#3869). A forge
// still Starting has not failed yet: its fetch is out, and the deadline line
// already says so.
func logFailedRefresh(sr sourceResult, forge Forge) {
	if sr.asked && !sr.Health.Reachable && !sr.Health.Starting {
		slog.Warn("full refresh failed", "forge", forge, "cause", sr.Health.ErrorKind, "error", sr.Health.Error)
	}
}

// ForgeFailureThreshold is how many fetches in a row must fail, whatever the
// cause, with the latest a forge's own 5xx, before the forge is shown as down.
// One gateway timeout on a heavy query among healthy fetches is not an outage
// (#3527); a request that got no response at all is not held back.
const ForgeFailureThreshold = 3

// add appends one source's result to the snapshot being built.
func (s *Snapshot) add(r Result) {
	s.Forges = append(s.Forges, r.Health)
	s.PullRequests = append(s.PullRequests, r.PullRequests...)
	s.Issues = append(s.Issues, r.Issues...)
	s.Repos = append(s.Repos, r.Repos...)
	s.MainBranches = append(s.MainBranches, r.MainBranches...)
}

// cloneStreaks is a writable copy of m, empty when m is nil.
func cloneStreaks(m map[Forge]int) map[Forge]int {
	out := make(map[Forge]int, len(m))
	maps.Copy(out, m)

	return out
}

// settleOrHold is forge's result for the snapshot: held over from earlier for a
// blip of the forge's own 5xx, else settled as settleSource does.
func settleOrHold(r Result, asked, missed bool, earlier Snapshot, goodAt map[Forge]time.Time, streaks map[Forge]int, now time.Time, readForges map[Forge]bool, unread map[repoKey]bool, forge Forge) Result {
	if held, ok := holdUpstreamError(r, asked, missed, earlier, goodAt, streaks, forge); ok {
		return held
	}
	if missed && streaks[forge] >= ForgeFailureThreshold {
		r.Health = endStarting(r.Health)
	}

	return settleSource(r, asked, earlier, goodAt, now, readForges, unread, forge)
}

// endStarting is h for a forge that has missed ForgeFailureThreshold passes in
// a row: one still Starting has now had as long as a forge that was read, so it
// is down rather than starting up (#5022). Any other h is returned unchanged.
func endStarting(h ForgeHealth) ForgeHealth {
	if !h.Starting {
		return h
	}
	h.Starting = false

	return markUnreachable(h)
}

// holdUpstreamError counts forge's consecutive failed fetches in streaks, and
// turns the first ForgeFailureThreshold-1 failures that were the forge's own 5xx,
// or a pass that missed (scheduled deadline hit, or skipped while a fetch past
// it still ran), into the rows and health it last had, so the page does not flip
// to a banner for a blip. A fetch that read the forge resets the count. A forge nobody
// asked (budget spent) is left out: only a real answer or a missed pass moves
// the count.
func holdUpstreamError(r Result, asked, missed bool, earlier Snapshot, goodAt map[Forge]time.Time, streaks map[Forge]int, forge Forge) (Result, bool) {
	if !asked && !missed {
		return r, false
	}
	if r.Health.Reachable {
		streaks[forge] = 0

		return r, false
	}
	streaks[forge]++
	if !missed && r.Health.ErrorKind != ForgeErrorUpstream || streaks[forge] >= ForgeFailureThreshold {
		return r, false
	}
	readAt, good := goodAt[forge]
	if !good {
		return r, false
	}
	prev, ok := healthOf(earlier, forge)
	if !ok || !prev.Reachable {
		return r, false
	}
	held := rowsWhere(earlier, func(other Forge) bool { return other == forge })
	held.Health = notSlow(prev)
	if missed {
		held.Health.Cause = ForgeCauseSlow
		held.Health.RowsReadAt = &readAt
	}

	return held, true
}

// settleSource is forge's result as the snapshot should show it: freshly read
// (noting the forge in readForges and the repos it could not read in unread),
// held back, or carried over from earlier after a failed fetch. goodAt is
// updated for a forge that was read.
func settleSource(r Result, asked bool, earlier Snapshot, goodAt map[Forge]time.Time, now time.Time, readForges map[Forge]bool, unread map[repoKey]bool, forge Forge) Result {
	at, good := goodAt[forge]
	switch {
	case r.Health.Reachable && asked:
		goodAt[forge] = now
		readForges[forge] = true
		for _, f := range r.FailedRepos {
			unread[repoKey{forge, f.FullName}] = true
		}

		return keepUnchangedRepos(keepFailedRepos(r, earlier, forge), earlier, forge)
	case r.Health.Reachable:
		// Held back (budget spent or at its reserve): nothing was read, so the
		// rows are the old ones, and they say so instead of passing for this
		// refresh's.
		return markReposStale(r, at, good)
	case good:
		// A failed fetch carries no data. Showing none would drop every row of
		// this forge until the next good refresh (#922), so show what it last
		// had, and say how old that is.
		r = carryOver(r, earlier, forge)
		r.Health.StaleSince = &at
		r.Repos = markCarriedRepos(r.Repos, earlier, forge, at)
	}

	return r
}

// noteFullRead records, under mu, which forges the full refresh with sequence
// number seq read, and which of their repos it could not.
func (a *Aggregator) noteFullRead(seq uint64, readForges map[Forge]bool, unread map[repoKey]bool) {
	for forge := range readForges {
		a.fullSeq[forge] = max(a.fullSeq[forge], seq)
	}
	for key := range a.unread {
		if readForges[key.forge] {
			delete(a.unread, key)
		}
	}
	maps.Copy(a.unread, unread)
}

// reachableForges says which forges answered, by forge.
func reachableForges(forges []ForgeHealth) map[Forge]bool {
	reachable := make(map[Forge]bool, len(forges))
	for _, h := range forges {
		reachable[h.Forge] = h.Reachable
	}

	return reachable
}

// rowsRead is the settledKey of each pull request the sources asked returned.
// That is what the forge was asked for: a source held back on its budget, and
// the keep and carry-over steps of a refresh, add rows from the snapshot, which
// no fetch read.
// markReposStale is res with every repo that has no stale mark marked as last
// read at since. It copies the slice: the snapshot's own is shared with readers.
func markReposStale(res Result, since time.Time, ok bool) Result {
	if !ok {
		return res
	}
	res.Repos = slices.Clone(res.Repos)
	for i := range res.Repos {
		if res.Repos[i].StaleSince == nil {
			res.Repos[i].StaleSince = &since
		}
	}

	return res
}

func rowsRead(results []sourceResult) readRows {
	read := make(map[string]bool)
	for _, r := range results {
		if !r.asked {
			continue
		}
		for _, pr := range r.PullRequests {
			read[settledKey(pr.Forge, pr.Repo, pr.Number)] = true
		}
	}

	return onlyRead(read)
}

// publish tells the subscribers about snap and saves it for the next start.
func (a *Aggregator) publish(ctx context.Context, snap Snapshot) {
	a.notify(snap)
	a.saveSnapshot(ctx, snap)
}

// markFirstRefreshed flips the readiness latch and wakes WaitFirstRefresh.
func (a *Aggregator) markFirstRefreshed() {
	a.firstRefreshed.Store(true)
	a.firstRefreshedOnce.Do(func() { close(a.firstRefreshedCh) })
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
// NextDelay against the snapshot that refresh just produced. NextDelay
// stretches interval while every tracked repo has a healthy webhook, then
// pushes the result out past a forge's reset when its rate-limit budget is
// critically low, instead of firing on schedule into an already-exhausted
// quota (#381). A plain Timer, not a Ticker, since the delay changes cycle to
// cycle rather than staying fixed. Meant to run in its own goroutine for
// the lifetime of the process.
//
// While the Activity says nobody is using the dashboard, a due tick is
// skipped and the timer re-armed, so an unwatched dashboard spends no forge
// budget on the schedule. The exception is a tick something is waiting on
// (automationPending): a pull request armed for merge, or a behind one the
// auto-update hook has yet to try, is only ever acted on after a refresh. The first use after that wakes Run, which refreshes
// once so the person who just arrived is not shown data from before they left.
func (a *Aggregator) Run(ctx context.Context, interval time.Duration) {
	if ctx.Err() != nil {
		// Replaced before it started. No first refresh is coming, so let go
		// of anyone waiting for one. Any wake is the successor's.
		a.markFirstRefreshed()

		return
	}
	// A wake left over from before this refresh (a sign-in builds this
	// Aggregator and then its first request wakes it) is answered by it. Drained
	// first, not after: one that arrives while the refresh runs is a real
	// request and still gets its catch-up.
	a.activity.drainWake()
	a.refreshBackground(ctx)

	timer := a.newRunTimer(a.NextDelay(interval))
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C():
			a.scheduledPass(ctx)
		case <-a.activity.Woken():
			a.catchUpPass(ctx)
			stopAndDrain(timer)
		}
		// select picks at random between ready cases, so a tick or a wake can
		// win over a cancellation that is already there (#5041). The passes
		// do nothing then, and this ends the loop.
		if ctx.Err() != nil {
			return
		}
		timer.Reset(a.NextDelay(interval))
	}
}

// scheduledPass is what a tick does: a background refresh, unless Run was
// cancelled or the dashboard is idle with nothing waiting on a refresh.
func (a *Aggregator) scheduledPass(ctx context.Context) {
	if ctx.Err() != nil || (a.activity.Idle() && !a.automationPending(ctx)) {
		return
	}
	a.refreshBackground(ctx)
}

// catchUpPass is what a wake does, unless Run was cancelled, when the wake goes
// back for the successor to read. Someone opened the board after an idle spell:
// the refresh is theirs, not the schedule's, so the reserve is for it.
func (a *Aggregator) catchUpPass(ctx context.Context) {
	if ctx.Err() != nil {
		a.activity.handBackWake()

		return
	}
	a.Refresh(ctx)
}

// stopAndDrain stops timer and discards a tick it had already sent, so the
// next Reset starts a full wait.
func stopAndDrain(timer RunTimer) {
	if timer.Stop() {
		return
	}
	select {
	case <-timer.C():
	default:
	}
}

// armedOnForge reports whether pr has the forge's own auto-merge armed, as GitHub's is. The forge
// merges it by itself once checks pass, so nothing the dashboard does makes it
// happen and a webhook may never tell the dashboard it did: the repo is polled
// for as long as the pull request stays armed, which is one scoped query a
// minute per repo, until it merges and leaves the board (#1505).
func armedOnForge(pr PullRequest) bool {
	return forgeMergesArmed(pr.Forge) && pr.AutoMergeEnabled != nil && *pr.AutoMergeEnabled
}

// RunCIPoll runs PollCI on a fixed interval until ctx is cancelled, and starts
// no poll after that. It is PollCI's own ticker-loop counterpart, the same
// relationship Run has to Refresh. A plain Ticker, unlike Run's
// rate-limit-aware Timer: PollCI's own per-tick cost is bounded to the repos
// with something pending or armed, and it skips a forge whose budget is spent
// itself, so it doesn't need the delay Run computes for its account-wide pass.
// Meant to run in its own goroutine for the lifetime of the process, alongside
// Run.
func (a *Aggregator) RunCIPoll(ctx context.Context, interval time.Duration) {
	a.ciBase.Store(int64(interval))
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// A tick can win over a cancellation that is already there, as
			// in Run.
			if ctx.Err() != nil {
				return
			}
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
			// A spent budget is skipped by fetchSources, so waiting out its
			// reset would only slow the other forge down.
			if !criticallyLow(rl) || rl.Remaining == 0 {
				continue
			}
			untilReset := min(rl.ResetsAt.Sub(now)+backoffBuffer, maxBackoff)
			delay = max(delay, untilReset)
		}
	}

	return delay
}

// carryOver returns res with the pull requests, issues, repos and default
// branches forge had in earlier, for a refresh where its fetch failed and
// returned none. The default-branch rows are marked stale (#1224).
func carryOver(res Result, earlier Snapshot, forge Forge) Result {
	res.PullRequests = slices.DeleteFunc(slices.Clone(earlier.PullRequests), func(pr PullRequest) bool { return pr.Forge != forge })
	res.Issues = slices.DeleteFunc(slices.Clone(earlier.Issues), func(i Issue) bool { return i.Forge != forge })
	res.Repos = slices.DeleteFunc(slices.Clone(earlier.Repos), func(r Repo) bool { return r.Forge != forge })
	res.MainBranches = markMainBranchesStale(
		slices.DeleteFunc(slices.Clone(earlier.MainBranches), func(b MainBranch) bool { return b.Forge != forge }),
		earlier.GeneratedAt,
	)

	return res
}

// markCarriedRepos is repos with each repo that has no stale mark marked as last
// read at since, when forge has just failed: the rows it carries over are old,
// and each repo says so, so a scoped refresh can make one current while the
// others stay marked (#3869). A forge that was already failing keeps its repos
// as they were: a repo without a mark is one a scoped refresh made current since,
// and marking it again would call it old. It copies the slice: the snapshot's
// own is shared with readers.
func markCarriedRepos(repos []Repo, earlier Snapshot, forge Forge, since time.Time) []Repo {
	if prev, ok := healthOf(earlier, forge); ok && !prev.Reachable {
		return repos
	}

	return markReposStale(Result{Repos: repos}, since, true).Repos
}

// withoutStale is repos with StaleSince cleared on the rows of forge's repos
// named in fullNames. It leaves FailingSince: a scoped refresh fetches what a
// webhook told it about, not what the full refresh keeps failing on, so only a
// good full refresh ends the failure. It copies the slice once, and only when
// there is a mark to clear, since the snapshot's own slice is shared with
// readers.
func withoutStale(repos []Repo, forge Forge, fullNames map[string]bool) []Repo {
	var out []Repo
	for i, r := range repos {
		if r.Forge != forge || !fullNames[r.FullName] || r.StaleSince == nil {
			continue
		}
		if out == nil {
			out = slices.Clone(repos)
		}
		out[i].StaleSince = nil
	}
	if out == nil {
		return repos
	}

	return out
}

// keepFailedRepos puts back what the forge had for each repo it answered but
// could not fully fetch. A list that failed is not an empty one, and
// dropping it blanked the repo's rows until the next good fetch (#1194). The
// repo says since when its rows are the old ones. A part that did fetch keeps
// the forge's own answer.
func keepFailedRepos(res Result, earlier Snapshot, forge Forge) Result {
	res.Repos = slices.Clone(res.Repos)
	for _, failed := range res.FailedRepos {
		key := repoKey{forge, failed.FullName}
		if failed.PullRequests {
			res.PullRequests = append(res.PullRequests, slices.DeleteFunc(slices.Clone(earlier.PullRequests), func(pr PullRequest) bool {
				return (repoKey{pr.Forge, pr.Repo}) != key
			})...)
		}
		if failed.Issues {
			res.Issues = append(res.Issues, slices.DeleteFunc(slices.Clone(earlier.Issues), func(i Issue) bool {
				return (repoKey{i.Forge, i.Repo}) != key
			})...)
		}
		if failed.MainBranch {
			res.MainBranches = append(res.MainBranches, markMainBranchesStale(slices.DeleteFunc(slices.Clone(earlier.MainBranches), func(b MainBranch) bool {
				return (repoKey{b.Forge, b.FullName}) != key
			}), earlier.GeneratedAt)...)
		}
		markRepoStale(res.Repos, earlier, key)
	}

	return res
}

// markRepoStale sets StaleSince on key's repo in repos: when its rows were
// last fetched, which is the earlier snapshot unless that was stale already,
// and FailingSince: when the failure began, kept from the earlier snapshot while
// the repo keeps failing.
func markRepoStale(repos []Repo, earlier Snapshot, key repoKey) {
	since := earlier.GeneratedAt
	failing := time.Now().UTC()
	for _, r := range earlier.Repos {
		if (repoKey{r.Forge, r.FullName}) != key {
			continue
		}
		if r.StaleSince != nil {
			since = *r.StaleSince
		}
		if r.FailingSince != nil {
			failing = *r.FailingSince
		}
	}
	if since.IsZero() {
		// Nothing was fetched before, so the rows date from the failure.
		since = failing
	}
	for i := range repos {
		if (repoKey{repos[i].Forge, repos[i].FullName}) == key {
			repos[i].StaleSince = &since
			repos[i].FailingSince = &failing
		}
	}
}

// repoKey names one repository on one forge.
type repoKey struct {
	forge Forge
	repo  string
}

// keepNewerScopedRepos stops a full refresh from undoing a webhook's scoped
// refresh that landed while it was fetching (#966). A full refresh can take
// longer than a webhook delivery takes to arrive, so a pull request merged
// meanwhile is already gone from the snapshot, while the full refresh, which
// read the forge before the merge, still lists it. For every repo a scoped
// refresh merged after this full one started (a larger seq), the snapshot's
// current entries win, the repo's own row included. Every other repo takes the full refresh's data.
func (a *Aggregator) keepNewerScopedRepos(snap, current Snapshot, seq uint64) Snapshot {
	newer := make(map[repoKey]bool)
	for key, scopedSeq := range a.scopedSeq {
		if scopedSeq > seq {
			newer[key] = true
		}
	}
	if len(newer) == 0 {
		return snap
	}

	prs := slices.DeleteFunc(slices.Clone(snap.PullRequests), func(pr PullRequest) bool {
		return newer[repoKey{pr.Forge, pr.Repo}]
	})
	for _, pr := range current.PullRequests {
		if newer[repoKey{pr.Forge, pr.Repo}] {
			prs = append(prs, pr)
		}
	}
	issues := slices.DeleteFunc(slices.Clone(snap.Issues), func(i Issue) bool {
		return newer[repoKey{i.Forge, i.Repo}]
	})
	for _, i := range current.Issues {
		if newer[repoKey{i.Forge, i.Repo}] {
			issues = append(issues, i)
		}
	}

	repos := keepRows(snap.Repos, current.Repos, newer)

	snap.PullRequests, snap.Issues, snap.Repos = prs, issues, repos
	// The full refresh's forge row carries the failure mark. When scoped
	// refreshes have made every repo current, the mark is over (#4108).
	for key := range newer {
		snap.Forges, _ = clearMarkWhenFresh(snap.Forges, snap.Repos, key.forge)
	}
	AnnotateStacks(snap.PullRequests)
	sortByRecency(snap.PullRequests, snap.Issues)

	return snap
}

// keepRows is repos with the row of each repo in newer replaced by current's.
// The row carries the stale mark, which a scoped refresh may have cleared;
// taking the full refresh's row would write the mark back.
func keepRows(repos, current []Repo, newer map[repoKey]bool) []Repo {
	kept := make(map[repoKey]Repo, len(newer))
	for _, r := range current {
		if key := (repoKey{r.Forge, r.FullName}); newer[key] {
			kept[key] = r
		}
	}
	out := slices.Clone(repos)
	for i, r := range out {
		if row, ok := kept[repoKey{r.Forge, r.FullName}]; ok {
			out[i] = row
		}
	}

	return out
}

// clearMarkWhenFresh ends a forge's mark once a scoped refresh has replaced
// every repo it showed from an earlier answer: the start-up mark of a forge
// showing the last run's rows, or the failure mark of a forge whose full
// refresh failed. The forge answered for each of its repos, and nothing on
// screen is old any more. While another repo still carries an earlier answer the
// mark stays, since those rows are still old. forges is never edited in place; a
// reader may hold it.
func clearMarkWhenFresh(forges []ForgeHealth, repos []Repo, forge Forge) (out []ForgeHealth, cleared bool) {
	i := slices.IndexFunc(forges, func(h ForgeHealth) bool {
		return h.Forge == forge && (h.Starting || (!h.Reachable && h.StaleSince != nil))
	})
	if i < 0 {
		return forges, false
	}
	if slices.ContainsFunc(repos, func(r Repo) bool {
		return r.Forge == forge && ClaimOfRow(ClaimState, r.StaleSince).State == ClaimCarriedOver
	}) {
		return forges, false
	}
	out = slices.Clone(forges)
	out[i].Starting = false
	out[i].Cause = ""
	out[i].RowsReadAt = nil
	out[i].Reachable = true
	out[i].StaleSince = nil
	out[i].Error = ""
	out[i].ErrorKind = ""
	out[i].UpstreamStatus = 0
	out[i].ProviderStatus = nil

	return out, true
}

// noteBlockedActions records on a forge's health what its source says it
// can't do, so the page can lock those controls instead of letting a click
// fail.
func noteBlockedActions(h *ForgeHealth, src Source) {
	h.DependabotCommandsBlocked = DependabotCommandsBlockedReason(src)
	h.RerunChecksBlocked = RerunChecksBlockedReason(src)
}

// noteProviderStatus records what the forge's status page says, when the forge
// has just failed for a reason its provider could be behind: it didn't answer,
// or answered with a 5xx. A bad token, a spent rate limit and a restart that
// hasn't asked yet are not the provider's incident, so they cost no request.
func noteProviderStatus(ctx context.Context, h *ForgeHealth, src Source) {
	if h.Reachable || h.Starting {
		return
	}
	if h.ErrorKind != ForgeErrorUnreachable && h.ErrorKind != ForgeErrorUpstream && h.ErrorKind != ForgeErrorUnknown {
		return
	}
	if ps, ok := src.(ProviderStatusSource); ok {
		h.ProviderStatus = ps.ProviderStatus(ctx)
	}
}
