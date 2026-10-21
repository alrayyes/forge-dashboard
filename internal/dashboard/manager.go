package dashboard

import (
	"context"
	"sync"
	"time"
)

// Manager owns one Aggregator per user, each refreshing itself in the
// background on its own schedule — the per-user equivalent of a single
// global Aggregator, now that each user's dashboard reflects their own
// saved forge credentials rather than one shared environment-configured
// set.
type Manager struct {
	mu              sync.Mutex
	users           map[string]*managedAggregator
	refreshInterval time.Duration
	// autoUpdateBranchLister is nil until SetAutoUpdateBranchLister is
	// called — every Aggregator this Manager builds before that point,
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
	// Aggregator this Manager builds before that point, or ever, if
	// it's never called, skips the CI-poll fallback (#177) entirely.
	ciPollInterval time.Duration
	// activity is nil until SetActivity is called; every Aggregator built
	// before that, or ever, if it's never called, refreshes on its schedule
	// whether or not anyone is using the dashboard.
	activity *Activity
	// firstRefreshSeen latches once any Aggregator finishes its first
	// refresh, so a later sign-in (a new Aggregator, mid-refresh) can't
	// flip a serving process back to unready.
	firstRefreshSeen bool
	// firstRefreshGrace is how long an Aggregator's first refresh is waited
	// for before the process counts as ready anyway (#893).
	firstRefreshGrace time.Duration
	// refreshedOnce holds every user whose first refresh since this process
	// started has finished, whether it succeeded or failed (#1673). It lives
	// here and not on the Aggregator because a settings save replaces the
	// Aggregator, and the mark must survive that. Never persisted: a restart
	// clears it, which is what the loading state is for.
	refreshedOnce map[string]struct{}
	// forceRefreshCooldown is the window ForceRefresh throttles inside.
	forceRefreshCooldown time.Duration
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
	// lastForced is when ForceRefresh last fetched, guarded by Manager.mu.
	lastForced time.Time
}

// NewManager returns a Manager whose per-user Aggregators refresh every
// refreshInterval.
func NewManager(refreshInterval time.Duration) *Manager {
	return &Manager{
		users:             make(map[string]*managedAggregator),
		refreshedOnce:     make(map[string]struct{}),
		refreshInterval:   refreshInterval,
		firstRefreshGrace: defaultFirstRefreshGrace,

		forceRefreshCooldown: DefaultForceRefreshCooldown,
	}
}

// SetAutoUpdateBranchLister turns on the auto-update-branch hook (#365)
// for every Aggregator this Manager builds from here on — a setter
// rather than a NewManager parameter so every existing caller (the
// composition root's own construction, and every test building a
// Manager with no interest in this feature) is unaffected. Call once,
// before the first Ensure/EnsureIfAbsent that should carry it; an
// Aggregator already running when this is called keeps running without
// it until its own next Ensure rebuilds it.
func (m *Manager) SetAutoUpdateBranchLister(lister AutoUpdateBranchLister) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.autoUpdateBranchLister = lister
}

// SetWebhookDebounceTimer replaces the timer every Aggregator this Manager
// builds from here on holds webhook-triggered refreshes with, for tests that
// drive time by hand. Call once, before the first Ensure.
func (m *Manager) SetWebhookDebounceTimer(after AfterFunc) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.debounceTimer = after
}

// SetAutoMergeStore turns on the Forgejo auto-merge hook for every Aggregator
// this Manager builds from here on, the same way SetAutoUpdateBranchLister
// does: call once, before the first Ensure.
func (m *Manager) SetAutoMergeStore(store AutoMergeStore) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.autoMergeStore = store
}

// SetQueuedActionStore turns on running the actions users queued for a rate
// limit's reset (#756) for every Aggregator this Manager builds from here on,
// the way SetAutoMergeStore does: call once, before the first Ensure.
func (m *Manager) SetQueuedActionStore(store QueuedActionStore) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.queuedActionStore = store
}

// SetWebhookUpgrade turns on the once-per-start upgrade of app-created
// webhooks (#1555) for every Aggregator this Manager builds from here on.
// origin is the app's public origin, which the hooks' target URLs start with.
// The record of which repos were visited lives here, not in an Aggregator, so
// it spans credential saves and sign-ins for the life of the process. Call
// once, before the first Ensure.
func (m *Manager) SetWebhookUpgrade(creds WebhookCredentialSource, origin string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.webhookCreds = creds
	m.webhookOrigin = origin
	m.webhookUpgrade = NewWebhookUpgrades(DefaultWebhookUpgradeJitter)
}

// SetCIPollInterval turns on the CI-status poll fallback (#177) for
// every Aggregator this Manager builds from here on — a setter rather
// than a NewManager parameter, the same reason
// SetAutoUpdateBranchLister is one: every existing caller (the
// composition root's own construction, and every test with no
// interest in this feature) is unaffected. Call once, before the
// first Ensure/EnsureIfAbsent that should carry it; an Aggregator
// already running when this is called keeps running without it until
// its own next Ensure rebuilds it. Zero (the default) leaves the poll
// off entirely — Aggregator.PollCI/RunCIPoll's own doc comments cover
// why a real deployment wants it on.
func (m *Manager) SetCIPollInterval(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ciPollInterval = d
}

// SetActivity lets the scheduled refresh rest while nobody is using the
// dashboard. The same Activity is what the HTTP layer touches, so it is the
// one place that says whether anyone is there. Call once, before the first
// Ensure that should carry it; an Aggregator already running keeps running
// without it until its own next Ensure rebuilds it.
func (m *Manager) SetActivity(act *Activity) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.activity = act
}

// Activity is what SetActivity was given, or nil. Safe on a nil Manager, and
// a nil Activity is safe to touch, so a caller never has to check either.
func (m *Manager) Activity() *Activity {
	if m == nil {
		return nil
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	return m.activity
}

// Ensure (re)builds userID's Aggregator from sources and starts its
// background refresh, stopping whatever was running for that user
// before. Call it once after login (using their currently saved
// credentials) and again every time those credentials are saved —
// there's no way to add or remove a Source from a running Aggregator, so
// a changed configuration means a new one.
func (m *Manager) Ensure(ctx context.Context, userID []byte, sources []Source) {
	key := string(userID)

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.users[key]; ok {
		m.latchFirstRefreshLocked(key, existing)
		existing.cancel()
	}

	m.startLocked(ctx, key, userID, sources)
}

// EnsureIfAbsent is Ensure, but only takes effect if userID has no
// Aggregator running yet — the check and the insert happen under the
// same lock, unlike a separate Running() check followed by a call to
// Ensure(), which races when several requests for the same user land in
// the same instant (several browser tabs and an SSE reconnect, all
// arriving right after a restart wipes the Manager clean): each would
// see "not running" and each would create its own Aggregator with its
// own immediate Refresh. Concurrent callers here still each do their own
// harmless work building sources beforehand; only one gets to actually
// create the Aggregator and kick off its first Refresh.
func (m *Manager) EnsureIfAbsent(ctx context.Context, userID []byte, sources []Source) {
	key := string(userID)

	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.users[key]; ok {
		return
	}

	m.startLocked(ctx, key, userID, sources)
}

// startLocked builds userID's Aggregator from sources, with every hook this
// Manager has been given, and starts its background loops. The caller holds m.mu.
func (m *Manager) startLocked(ctx context.Context, key string, userID []byte, sources []Source) {
	runCtx, cancel := context.WithCancel(ctx)
	opts := []AggregatorOption{WithDebounceOwner(runCtx), WithActivity(m.activity)}
	if m.debounceTimer != nil {
		opts = append(opts, WithDebounceTimer(m.debounceTimer))
	}
	agg := NewAggregator(sources, opts...)
	if m.autoUpdateBranchLister != nil {
		agg.EnableAutoUpdateBranch(userID, m.autoUpdateBranchLister)
	}
	if m.autoMergeStore != nil {
		agg.EnableAutoMerge(userID, m.autoMergeStore)
	}
	if m.webhookCreds != nil {
		agg.EnableWebhookUpgrade(runCtx, userID, m.webhookCreds, m.webhookOrigin, m.webhookUpgrade)
	}
	m.users[key] = &managedAggregator{agg: agg, cancel: cancel, started: time.Now()}
	go agg.Run(runCtx, m.refreshInterval)
	if m.ciPollInterval > 0 {
		go agg.RunCIPoll(runCtx, m.ciPollInterval)
	}
	if m.queuedActionStore != nil {
		agg.EnableQueuedActions(userID, m.queuedActionStore)
		go agg.RunQueuedActions(runCtx)
	}
}

// latchFirstRefreshLocked records that entry's Aggregator had finished its
// first refresh before it goes away. The caller holds m.mu.
func (m *Manager) latchFirstRefreshLocked(key string, entry *managedAggregator) {
	if entry.agg.FirstRefreshDone() {
		m.refreshedOnce[key] = struct{}{}
	}
}

// FirstRefreshDone reports whether userID's first refresh since this process
// started has finished, whether it succeeded or failed (#1673). False until
// then, and for a user nothing has Ensured yet; true from then on, including
// while a rebuilt Aggregator refreshes again. It is per user: another user's
// refresh never flips it. The dashboard snapshot carries it so a page can show
// a loading state, not an empty board, in the gap after a restart.
func (m *Manager) FirstRefreshDone(userID []byte) bool {
	key := string(userID)

	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.refreshedOnce[key]; ok {
		return true
	}
	if entry, ok := m.users[key]; ok {
		m.latchFirstRefreshLocked(key, entry)
	}
	_, done := m.refreshedOnce[key]

	return done
}

// FirstRefreshComplete is the readiness answer for the dashboard half of
// /readyz. It is true when no Aggregator exists yet (Aggregators are built
// lazily per signed-in user, so a fresh process has nothing to wait for),
// and once any Aggregator has finished its first refresh, whether every
// forge answered or not. After that it stays true for the life of the
// Manager: forge reachability is dashboard data, not readiness.
func (m *Manager) FirstRefreshComplete() bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.firstRefreshSeen || len(m.users) == 0 {
		return true
	}
	for _, entry := range m.users {
		if entry.agg.FirstRefreshDone() || time.Since(entry.started) > m.firstRefreshGrace {
			m.firstRefreshSeen = true

			return true
		}
	}

	return false
}

// SetFirstRefreshGrace changes how long readiness waits for a first refresh
// before it counts as ready anyway (#893). A setter rather than a NewManager
// parameter, for the same reason SetCIPollInterval is one.
func (m *Manager) SetFirstRefreshGrace(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.firstRefreshGrace = d
}

// Get returns userID's current snapshot — empty, not nil arrays, if
// Ensure was never called for them (no credentials saved yet).
func (m *Manager) Get(userID []byte) Snapshot {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return newEmptySnapshot()
	}

	return entry.agg.Get()
}

// WaitFirstRefresh holds until userID's Aggregator has finished its first
// refresh, for up to limit, so a read right after a restart or a settings save
// gets the board and not the empty snapshot that precedes it. It returns at
// once for a user with no Aggregator, or one that has refreshed already.
func (m *Manager) WaitFirstRefresh(ctx context.Context, userID []byte, limit time.Duration) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if ok {
		entry.agg.WaitFirstRefresh(ctx, limit)
	}
}

// FindPullRequest returns the pull request userID's board holds for
// forge/repo/number. False when it isn't there, which says nothing against
// the pull request: the board may just not have caught up with it yet.
func (m *Manager) FindPullRequest(userID []byte, forge Forge, repo string, number int) (PullRequest, bool) {
	for _, pr := range m.Get(userID).PullRequests {
		if pr.Forge == forge && pr.Repo == repo && pr.Number == number {
			return pr, true
		}
	}

	return PullRequest{}, false
}

// Running reports whether userID currently has an Aggregator refreshing
// in the background. False right after a process restart for every user
// — the Manager holds no state across one — until something re-Ensures
// them; a caller can use this to tell "nothing saved in Settings" apart
// from "just needs rewarming from what's already saved."
func (m *Manager) Running(userID []byte) bool {
	m.mu.Lock()
	_, ok := m.users[string(userID)]
	m.mu.Unlock()

	return ok
}

// RefreshNow fetches userID's sources immediately, out of band from their
// regular refreshInterval ticker — the webhook handler's entry point for
// turning a forge event into an up-to-date snapshot within seconds rather
// than waiting for the next scheduled refresh. Reports false if userID has
// no running Aggregator (Ensure was never called for them), rather than
// silently doing nothing.
func (m *Manager) RefreshNow(ctx context.Context, userID []byte) bool {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return false
	}
	entry.agg.Refresh(ctx)

	return true
}

// DefaultForceRefreshCooldown is how long ForceRefresh leaves a user alone
// after one that fetched (#809).
const DefaultForceRefreshCooldown = 5 * time.Second

// SetForceRefreshCooldown changes the window ForceRefresh throttles inside.
// A setter, like SetCIPollInterval, so NewManager's callers are unaffected.
func (m *Manager) SetForceRefreshCooldown(d time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.forceRefreshCooldown = d
}

// ForceRefresh is RefreshNow for a user's own "refresh now" request, with a
// per-user cooldown so that call can't be used to spend a forge's API budget.
// A call inside the window does not fetch: it returns the time left, and the
// caller serves the current snapshot. A call that fetched returns zero. ok is
// false when userID has no running Aggregator, as with RefreshNow.
//
// Webhooks keep calling RefreshNow: a forge event isn't a user's click, and
// throttling it would leave the board stale.
func (m *Manager) ForceRefresh(ctx context.Context, userID []byte) (retryAfter time.Duration, ok bool) {
	m.mu.Lock()
	entry, found := m.users[string(userID)]
	if !found {
		m.mu.Unlock()

		return 0, false
	}
	if left := m.forceRefreshCooldown - time.Since(entry.lastForced); !entry.lastForced.IsZero() && left > 0 {
		m.mu.Unlock()

		return left, true
	}
	// Claimed before the fetch, so two clicks in the same instant fetch once.
	entry.lastForced = time.Now()
	m.mu.Unlock()

	entry.agg.Refresh(ctx)

	return 0, true
}

// MarkSettled delegates to userID's Aggregator — see
// Aggregator.MarkSettled. A user with no running Aggregator has no board to
// update, so it does nothing.
func (m *Manager) MarkSettled(userID []byte, forge Forge, repo string, number int) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.MarkSettled(forge, repo, number)
}

// Unsettle delegates to userID's Aggregator — see Aggregator.Unsettle.
func (m *Manager) Unsettle(userID []byte, forge Forge, repo string, number int) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.Unsettle(forge, repo, number)
}

// RecordBotRequest delegates to userID's Aggregator — see
// Aggregator.RecordBotRequest. A user with no running Aggregator has no board
// to show it on, so it does nothing.
func (m *Manager) RecordBotRequest(userID []byte, forge Forge, repo string, number int, bot BotName, action BotAction) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.RecordBotRequest(forge, repo, number, bot, action)
}

// RecordUpdateRequest delegates to userID's Aggregator — see
// Aggregator.RecordUpdateRequest. A user with no running Aggregator has no
// board to show it on, so it does nothing.
func (m *Manager) RecordUpdateRequest(userID []byte, forge Forge, repo string, number int) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.RecordUpdateRequest(forge, repo, number)
}

// QueuedActionsChanged delegates to userID's Aggregator, see
// Aggregator.QueuedActionsChanged. A user with no running Aggregator has
// nothing to wake and no subscribers, so it does nothing.
func (m *Manager) QueuedActionsChanged(userID []byte) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.QueuedActionsChanged()
}

// Republish delegates to userID's Aggregator, see Aggregator.Republish. A user
// with no running Aggregator has no subscribers, so it does nothing.
func (m *Manager) Republish(userID []byte) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return
	}
	entry.agg.Republish()
}

// RefreshRepo delegates to userID's Aggregator — see
// Aggregator.RefreshRepo. Reports false if userID has no running
// Aggregator, the same as RefreshNow, and also false wherever
// Aggregator.RefreshRepo itself would — a caller should fall back to
// RefreshNow either way, without needing to tell the two apart.
func (m *Manager) RefreshRepo(ctx context.Context, userID []byte, forge Forge, owner, name, fullName string, attrs ...any) bool {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return false
	}

	return entry.agg.RefreshRepo(ctx, forge, owner, name, fullName, attrs...)
}

// RefreshRepoDebounced delegates to userID's Aggregator — see
// Aggregator.RefreshRepoDebounced. Reports false if userID has no running
// Aggregator or the forge can't be scoped, so a caller falls back to
// RefreshNow without telling the two apart.
func (m *Manager) RefreshRepoDebounced(ctx context.Context, userID []byte, forge Forge, owner, name, fullName string, attrs ...any) bool {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return false
	}

	return entry.agg.RefreshRepoDebounced(ctx, forge, owner, name, fullName, attrs...)
}

// RecordDelivery delegates to userID's Aggregator — see
// Aggregator.RecordDelivery. A no-op if userID has no running Aggregator.
func (m *Manager) RecordDelivery(userID []byte, forge Forge, fullName, event string) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if ok {
		entry.agg.RecordDelivery(forge, fullName, event)
	}
}

// LastDelivery delegates to userID's Aggregator — see
// Aggregator.LastDelivery. Reports false if userID has no running Aggregator.
func (m *Manager) LastDelivery(userID []byte, forge Forge, fullName string, class EventClass) (time.Time, bool) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return time.Time{}, false
	}

	return entry.agg.LastDelivery(forge, fullName, class)
}

// Subscribe delegates to userID's Aggregator — see Aggregator.Subscribe.
// Reports false if userID has no running Aggregator.
func (m *Manager) Subscribe(userID []byte) (<-chan Snapshot, func(), bool) {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return nil, nil, false
	}
	ch, unsubscribe := entry.agg.Subscribe()

	return ch, unsubscribe, true
}

// Remove stops userID's refresh loop and evicts their snapshot — a no-op
// if they had none running. Used when an admin revokes or deletes an
// account, so a locked-out user's background refresh doesn't keep polling
// either forge for no one.
func (m *Manager) Remove(userID []byte) {
	key := string(userID)

	m.mu.Lock()
	defer m.mu.Unlock()

	if existing, ok := m.users[key]; ok {
		existing.cancel()
		delete(m.users, key)
	}
	delete(m.refreshedOnce, key)
}

// Stop cancels every running per-user refresh loop.
func (m *Manager) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, entry := range m.users {
		entry.cancel()
	}
	m.users = make(map[string]*managedAggregator)
}
