package dashboard

import (
	"context"
	"sync"
	"time"
)

// Service holds the one Aggregator the app runs, refreshing itself in the
// background on its own schedule. A settings save replaces the Aggregator, so
// the things that must outlive a replacement (the first-refresh marks, the
// force-refresh cooldown, the webhook upgrade record) live here.
type Service struct {
	mu              sync.Mutex
	current         *managedAggregator
	refreshInterval time.Duration
	// autoUpdateBranchLister is nil until SetAutoUpdateBranchLister is
	// called — every Aggregator this Service builds before that point,
	// or ever, if it's never called, skips the auto-update-branch hook
	// entirely (#365).
	autoUpdateBranchLister AutoUpdateBranchLister
	// autoMergeStore is nil until SetAutoMergeStore is called.
	autoMergeStore AutoMergeStore
	// queuedActionStore is nil until SetQueuedActionStore is called.
	queuedActionStore QueuedActionStore
	// webhookCreds is nil until SetWebhookUpgrade is called.
	webhookCreds   WebhookCredentialSource
	webhookOrigin  string
	webhookUpgrade *WebhookUpgrades
	// debounceTimer is nil until SetWebhookDebounceTimer is called, which
	// leaves every Aggregator on the real clock.
	debounceTimer AfterFunc
	// ciPollInterval is zero until SetCIPollInterval is called — every
	// Aggregator this Service builds before that point, or ever, if
	// it's never called, skips the CI-poll fallback (#177) entirely.
	ciPollInterval time.Duration
	// activity is nil until SetActivity is called; every Aggregator built
	// before that, or ever, if it's never called, refreshes on its schedule
	// whether or not anyone is using the dashboard.
	activity *Activity
	// firstRefreshSeen latches once the Aggregator finishes its first
	// refresh, so a later replacement (mid-refresh) can't flip a serving
	// process back to unready.
	firstRefreshSeen bool
	// firstRefreshGrace is how long an Aggregator's first refresh is waited
	// for before the process counts as ready anyway (#893).
	firstRefreshGrace time.Duration
	// refreshedOnce is set once the first refresh since this process started
	// has finished, whether it succeeded or failed (#1673). It lives here and
	// not on the Aggregator because a settings save replaces the Aggregator,
	// and the mark must survive that. Never persisted: a restart clears it,
	// which is what the loading state is for.
	refreshedOnce bool
	// forceRefreshCooldown is the window ForceRefresh throttles inside, and
	// lastForced is when it last fetched. Ensure keeps it, so a settings save
	// doesn't skip the throttle; Stop clears it.
	forceRefreshCooldown time.Duration
	lastForced           time.Time
	// snapshotCache is nil until SetSnapshotCache is called.
	snapshotCache SnapshotCache
	// seenStore is nil until SetWebhookSeenStore is called.
	seenStore WebhookSeenStore
}

// defaultFirstRefreshGrace is how long readiness waits for a first refresh. A
// forge that is slow or down must not keep the container unready: a deploy
// that waits for healthy would give up, and an orchestrator could restart a
// service that is serving fine.
const defaultFirstRefreshGrace = 30 * time.Second

type managedAggregator struct {
	agg     *Aggregator
	cancel  context.CancelFunc
	started time.Time
}

// NewService returns a Service whose Aggregator refreshes every
// refreshInterval.
func NewService(refreshInterval time.Duration) *Service {
	return &Service{
		refreshInterval:   refreshInterval,
		firstRefreshGrace: defaultFirstRefreshGrace,

		forceRefreshCooldown: DefaultForceRefreshCooldown,
	}
}

// SetAutoUpdateBranchLister turns on the auto-update-branch hook (#365)
// for every Aggregator this Service builds from here on — a setter
// rather than a NewService parameter so every existing caller (the
// composition root's own construction, and every test building a
// Service with no interest in this feature) is unaffected. Call once,
// before the first Ensure/EnsureIfAbsent that should carry it; an
// Aggregator already running when this is called keeps running without
// it until its own next Ensure rebuilds it.
func (m *Service) SetAutoUpdateBranchLister(lister AutoUpdateBranchLister) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.autoUpdateBranchLister = lister
}

// SetWebhookDebounceTimer replaces the timer every Aggregator this Service
// builds from here on holds webhook-triggered refreshes with, for tests that
// drive time by hand. Call once, before the first Ensure.
func (m *Service) SetWebhookDebounceTimer(after AfterFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.debounceTimer = after
}

// SetSnapshotCache keeps every Aggregator this Service builds from here on
// in cache across restarts: each starts from the saved snapshot, marked stale
// until its first refresh succeeds. Call once, before the first Ensure.
func (m *Service) SetSnapshotCache(cache SnapshotCache) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.snapshotCache = cache
}

// SetWebhookSeenStore keeps when each webhook delivery last arrived in store
// across restarts, for every Aggregator this Service builds from here on. Call
// once, before the first Ensure.
func (m *Service) SetWebhookSeenStore(store WebhookSeenStore) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seenStore = store
}

// SetAutoMergeStore turns on the Forgejo auto-merge hook for every Aggregator
// this Service builds from here on, the same way SetAutoUpdateBranchLister
// does: call once, before the first Ensure.
func (m *Service) SetAutoMergeStore(store AutoMergeStore) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.autoMergeStore = store
}

// SetQueuedActionStore turns on running the actions users queued for a rate
// limit's reset (#756) for every Aggregator this Service builds from here on,
// the way SetAutoMergeStore does: call once, before the first Ensure.
func (m *Service) SetQueuedActionStore(store QueuedActionStore) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.queuedActionStore = store
}

// SetWebhookUpgrade turns on the once-per-start upgrade of app-created
// webhooks (#1555) for every Aggregator this Service builds from here on.
// origin is the app's public origin, which the hooks' target URLs start with.
// The record of which repos were visited lives here, not in an Aggregator, so
// it spans credential saves and sign-ins for the life of the process. Call
// once, before the first Ensure.
func (m *Service) SetWebhookUpgrade(creds WebhookCredentialSource, origin string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.webhookCreds = creds
	m.webhookOrigin = origin
	m.webhookUpgrade = NewWebhookUpgrades(DefaultWebhookUpgradeJitter)
}

// SetCIPollInterval turns on the CI-status poll fallback (#177) for
// every Aggregator this Service builds from here on — a setter rather
// than a NewService parameter, the same reason
// SetAutoUpdateBranchLister is one: every existing caller (the
// composition root's own construction, and every test with no
// interest in this feature) is unaffected. Call once, before the
// first Ensure/EnsureIfAbsent that should carry it; an Aggregator
// already running when this is called keeps running without it until
// its own next Ensure rebuilds it. Zero (the default) leaves the poll
// off entirely — Aggregator.PollCI/RunCIPoll's own doc comments cover
// why a real deployment wants it on.
func (m *Service) SetCIPollInterval(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ciPollInterval = d
}

// SetActivity lets the scheduled refresh rest while nobody is using the
// dashboard. The same Activity is what the HTTP layer touches, so it is the
// one place that says whether anyone is there. Call once, before the first
// Ensure that should carry it; an Aggregator already running keeps running
// without it until its own next Ensure rebuilds it.
func (m *Service) SetActivity(act *Activity) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activity = act
}

// Activity is what SetActivity was given, or nil. Safe on a nil Service, and
// a nil Activity is safe to touch, so a caller never has to check either.
func (m *Service) Activity() *Activity {
	if m == nil {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	return m.activity
}

// Ensure (re)builds the Aggregator from sources and starts its background
// refresh, stopping whatever was running before. Call it after a settings
// save: there's no way to add or remove a Source from a running Aggregator, so
// a changed configuration means a new one.
func (m *Service) Ensure(ctx context.Context, sources []Source) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current != nil {
		m.latchFirstRefreshLocked()
		m.current.cancel()
	}

	m.startLocked(ctx, sources)
}

// EnsureFrom is Ensure, but load runs under the same lock as the swap. A
// caller that reads the saved credentials itself and then calls Ensure can be
// overtaken by a settings save in between, and its older read would then
// replace the newer Aggregator. load returns the sources and true, or false to
// leave whatever is running untouched (nothing saved, or the read failed).
func (m *Service) EnsureFrom(ctx context.Context, load func() ([]Source, bool)) {
	m.mu.Lock()
	defer m.mu.Unlock()

	sources, ok := load()
	if !ok {
		return
	}

	if m.current != nil {
		m.latchFirstRefreshLocked()
		m.current.cancel()
	}

	m.startLocked(ctx, sources)
}

// EnsureIfAbsent is Ensure, but only takes effect if no Aggregator is running
// yet. The check and the insert happen under the same lock, unlike a separate
// Running() check followed by Ensure(), which races when several requests land
// in the same instant (several browser tabs and an SSE reconnect, all arriving
// right after a restart): each would see "not running" and each would create
// its own Aggregator with its own immediate Refresh. Concurrent callers still
// each do their own harmless work building sources beforehand; only one gets
// to create the Aggregator and kick off its first Refresh.
func (m *Service) EnsureIfAbsent(ctx context.Context, sources []Source) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current != nil {
		return
	}

	m.startLocked(ctx, sources)
}

// startLocked builds the Aggregator from sources, with every hook this
// Service has been given, and starts its background loops. The caller holds m.mu.
func (m *Service) startLocked(ctx context.Context, sources []Source) {
	runCtx, cancel := context.WithCancel(ctx)
	opts := []AggregatorOption{WithDebounceOwner(runCtx), WithActivity(m.activity)}
	if m.debounceTimer != nil {
		opts = append(opts, WithDebounceTimer(m.debounceTimer))
	}
	if m.snapshotCache != nil {
		opts = append(opts, WithSnapshotCache(m.snapshotCache))
	}
	if m.seenStore != nil {
		opts = append(opts, WithWebhookSeenStore(m.seenStore))
	}
	agg := NewAggregator(sources, opts...)
	if m.autoUpdateBranchLister != nil {
		agg.EnableAutoUpdateBranch(m.autoUpdateBranchLister)
	}
	if m.autoMergeStore != nil {
		agg.EnableAutoMerge(m.autoMergeStore)
	}
	if m.webhookCreds != nil {
		agg.EnableWebhookUpgrade(runCtx, m.webhookCreds, m.webhookOrigin, m.webhookUpgrade)
	}
	m.current = &managedAggregator{agg: agg, cancel: cancel, started: time.Now()}
	go agg.Run(runCtx, m.refreshInterval)
	if m.ciPollInterval > 0 {
		go agg.RunCIPoll(runCtx, m.ciPollInterval)
	}
	if m.queuedActionStore != nil {
		agg.EnableQueuedActions(m.queuedActionStore)
		go agg.RunQueuedActions(runCtx)
	}
}

// latchFirstRefreshLocked records that the current Aggregator had finished its
// first refresh before it goes away. The caller holds m.mu.
func (m *Service) latchFirstRefreshLocked() {
	if m.current != nil && m.current.agg.FirstRefreshDone() {
		m.refreshedOnce = true
	}
}

// aggregator returns the running Aggregator, or nil when none has started.
func (m *Service) aggregator() *Aggregator {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current == nil {
		return nil
	}

	return m.current.agg
}

// FirstRefreshDone reports whether the first refresh since this process
// started has finished, whether it succeeded or failed (#1673). False until
// then, and while nothing has been Ensured; true from then on, including while
// a rebuilt Aggregator refreshes again. The dashboard snapshot carries it so a
// page can show a loading state, not an empty board, in the gap after a restart.
func (m *Service) FirstRefreshDone() bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.latchFirstRefreshLocked()

	return m.refreshedOnce
}

// FirstRefreshComplete is the readiness answer for the dashboard half of
// /readyz. It is true when no Aggregator exists yet (it is built lazily once
// settings exist, so a fresh process has nothing to wait for), and once the
// Aggregator has finished its first refresh, whether every forge answered or
// not. After that it stays true for the life of the Service: forge
// reachability is dashboard data, not readiness.
func (m *Service) FirstRefreshComplete() bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.firstRefreshSeen || m.current == nil {
		return true
	}
	if m.current.agg.FirstRefreshDone() || time.Since(m.current.started) > m.firstRefreshGrace {
		m.firstRefreshSeen = true

		return true
	}

	return false
}

// SetFirstRefreshGrace changes how long readiness waits for a first refresh
// before it counts as ready anyway (#893). A setter rather than a NewService
// parameter, for the same reason SetCIPollInterval is one.
func (m *Service) SetFirstRefreshGrace(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.firstRefreshGrace = d
}

// Get returns the current snapshot, empty (not nil arrays) if Ensure was never
// called (no credentials saved yet).
func (m *Service) Get() Snapshot {
	agg := m.aggregator()
	if agg == nil {
		return newEmptySnapshot()
	}

	return agg.Get()
}

// WaitFirstRefresh holds until the Aggregator has finished its first refresh,
// for up to limit, so a read right after a restart or a settings save gets the
// board and not the empty snapshot that precedes it. It returns at once when
// there is no Aggregator, or it has refreshed already.
func (m *Service) WaitFirstRefresh(ctx context.Context, limit time.Duration) {
	if agg := m.aggregator(); agg != nil {
		agg.WaitFirstRefresh(ctx, limit)
	}
}

// FindPullRequest returns the pull request the board holds for
// forge/repo/number. False when it isn't there, which says nothing against
// the pull request: the board may just not have caught up with it yet.
func (m *Service) FindPullRequest(forge Forge, repo string, number int) (PullRequest, bool) {
	for _, pr := range m.Get().PullRequests {
		if pr.Forge == forge && pr.Repo == repo && pr.Number == number {
			return pr, true
		}
	}

	return PullRequest{}, false
}

// Running reports whether an Aggregator is refreshing in the background. False
// right after a process restart — the Service holds no state across one —
// until something re-Ensures it; a caller can use this to tell "nothing saved
// in Settings" apart from "just needs rewarming from what's already saved."
func (m *Service) Running() bool {
	return m.aggregator() != nil
}

// RefreshNow fetches the sources immediately, out of band from the regular
// refreshInterval ticker — the webhook handler's entry point for turning a
// forge event into an up-to-date snapshot within seconds rather than waiting
// for the next scheduled refresh. Reports false if there is no running
// Aggregator (Ensure was never called), rather than silently doing nothing.
func (m *Service) RefreshNow(ctx context.Context) bool {
	agg := m.aggregator()
	if agg == nil {
		return false
	}
	agg.Refresh(ctx)

	return true
}

// DefaultForceRefreshCooldown is how long ForceRefresh leaves the board alone
// after one that fetched (#809).
const DefaultForceRefreshCooldown = 5 * time.Second

// SetForceRefreshCooldown changes the window ForceRefresh throttles inside.
// A setter, like SetCIPollInterval, so NewService's callers are unaffected.
func (m *Service) SetForceRefreshCooldown(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forceRefreshCooldown = d
}

// ForceRefresh is RefreshNow for the user's own "refresh now" request, with a
// cooldown so that call can't be used to spend a forge's API budget. A call
// inside the window does not fetch: it returns the time left, and the caller
// serves the current snapshot. So does a call while the first refresh since
// boot is still running: it returns the cooldown and does not wait. A call that
// fetched returns zero. ok is false
// when there is no running Aggregator, as with RefreshNow.
//
// Webhooks keep calling RefreshNow: a forge event isn't a user's click, and
// throttling it would leave the board stale.
func (m *Service) ForceRefresh(ctx context.Context) (retryAfter time.Duration, ok bool) {
	m.mu.Lock()
	if m.current == nil {
		m.mu.Unlock()

		return 0, false
	}
	agg := m.current.agg
	// The first refresh since boot is still running: Refresh would coalesce
	// onto it and wait for all of it, long enough for a proxy to cut the
	// request off. Answer with the current snapshot and the cooldown instead.
	// Nothing is claimed in lastForced, as nothing was fetched.
	m.latchFirstRefreshLocked()
	if !m.refreshedOnce {
		m.mu.Unlock()

		return m.forceRefreshCooldown, true
	}
	if left := m.forceRefreshCooldown - time.Since(m.lastForced); !m.lastForced.IsZero() && left > 0 {
		m.mu.Unlock()

		return left, true
	}
	// Claimed before the fetch, so two clicks in the same instant fetch once.
	m.lastForced = time.Now()
	m.mu.Unlock()

	agg.Refresh(ctx)

	return 0, true
}

// MarkSettled delegates to the Aggregator — see Aggregator.MarkSettled. With
// none running there is no board to update, so it does nothing.
func (m *Service) MarkSettled(forge Forge, repo string, number int) {
	if agg := m.aggregator(); agg != nil {
		agg.MarkSettled(forge, repo, number)
	}
}

// Unsettle delegates to the Aggregator — see Aggregator.Unsettle.
func (m *Service) Unsettle(forge Forge, repo string, number int) {
	if agg := m.aggregator(); agg != nil {
		agg.Unsettle(forge, repo, number)
	}
}

// RecordBotRequest delegates to the Aggregator — see
// Aggregator.RecordBotRequest. With none running there is no board to show it
// on, so it does nothing.
func (m *Service) RecordBotRequest(forge Forge, repo string, number int, bot BotName, action BotAction) {
	if agg := m.aggregator(); agg != nil {
		agg.RecordBotRequest(forge, repo, number, bot, action)
	}
}

// RecordUpdateRequest delegates to the Aggregator — see
// Aggregator.RecordUpdateRequest. With none running there is no board to show
// it on, so it does nothing.
func (m *Service) RecordUpdateRequest(forge Forge, repo string, number int) {
	if agg := m.aggregator(); agg != nil {
		agg.RecordUpdateRequest(forge, repo, number)
	}
}

// QueuedActionsChanged delegates to the Aggregator, see
// Aggregator.QueuedActionsChanged. With none running there is nothing to wake
// and no subscribers, so it does nothing.
func (m *Service) QueuedActionsChanged() {
	if agg := m.aggregator(); agg != nil {
		agg.QueuedActionsChanged()
	}
}

// Republish delegates to the Aggregator, see Aggregator.Republish. With none
// running there are no subscribers, so it does nothing.
func (m *Service) Republish() {
	if agg := m.aggregator(); agg != nil {
		agg.Republish()
	}
}

// RefreshRepo delegates to the Aggregator — see Aggregator.RefreshRepo.
// Reports false if none is running, the same as RefreshNow, and also false
// wherever Aggregator.RefreshRepo itself would — a caller should fall back to
// RefreshNow either way, without needing to tell the two apart.
func (m *Service) RefreshRepo(ctx context.Context, forge Forge, owner, name, fullName string, attrs ...any) bool {
	agg := m.aggregator()
	if agg == nil {
		return false
	}

	return agg.RefreshRepo(ctx, forge, owner, name, fullName, attrs...)
}

// RefreshRepoDebounced delegates to the Aggregator — see
// Aggregator.RefreshRepoDebounced. Reports false if none is running or the
// forge can't be scoped, so a caller falls back to RefreshNow without telling
// the two apart.
func (m *Service) RefreshRepoDebounced(ctx context.Context, forge Forge, owner, name, fullName string, attrs ...any) bool {
	agg := m.aggregator()
	if agg == nil {
		return false
	}

	return agg.RefreshRepoDebounced(ctx, forge, owner, name, fullName, attrs...)
}

// RecordDelivery delegates to the Aggregator — see Aggregator.RecordDelivery.
// A no-op if none is running.
func (m *Service) RecordDelivery(forge Forge, fullName, event string) {
	if agg := m.aggregator(); agg != nil {
		agg.RecordDelivery(forge, fullName, event)
	}
}

// RecordCheckDelivery delegates to the Aggregator — see
// Aggregator.RecordCheckDelivery. A no-op if none is running.
func (m *Service) RecordCheckDelivery(forge Forge, fullName, sha string) {
	if agg := m.aggregator(); agg != nil {
		agg.RecordCheckDelivery(forge, fullName, sha)
	}
}

// LastCheckDelivery delegates to the Aggregator — see
// Aggregator.LastCheckDelivery. Reports false if none is running.
func (m *Service) LastCheckDelivery(forge Forge, fullName, sha string) (time.Time, bool) {
	agg := m.aggregator()
	if agg == nil {
		return time.Time{}, false
	}

	return agg.LastCheckDelivery(forge, fullName, sha)
}

// LastDelivery delegates to the Aggregator — see Aggregator.LastDelivery.
// Reports false if none is running.
func (m *Service) LastDelivery(forge Forge, fullName string, class EventClass) (time.Time, bool) {
	agg := m.aggregator()
	if agg == nil {
		return time.Time{}, false
	}

	return agg.LastDelivery(forge, fullName, class)
}

// Subscribe delegates to the Aggregator — see Aggregator.Subscribe. Reports
// false if none is running.
func (m *Service) Subscribe() (<-chan Snapshot, func(), bool) {
	agg := m.aggregator()
	if agg == nil {
		return nil, nil, false
	}
	ch, unsubscribe := agg.Subscribe()

	return ch, unsubscribe, true
}

// Stop cancels the running refresh loop and nothing else. The first-refresh
// marks and the force-refresh cooldown stay, so a pause or shutdown can't hand
// out a free refresh. Reset puts those back to a fresh process.
func (m *Service) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.current != nil {
		m.current.cancel()
	}
	m.current = nil
}

// Reset returns the Service to how a fresh process starts: no first-refresh
// marks and no force-refresh cooldown. A restart and the e2e reset both mean
// that, so they call Stop and then Reset. A settings save goes through Ensure
// instead, which keeps the marks and the cooldown so a save can't be used to
// dodge the throttle.
func (m *Service) Reset() {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.refreshedOnce = false
	m.firstRefreshSeen = false
	m.lastForced = time.Time{}
}
