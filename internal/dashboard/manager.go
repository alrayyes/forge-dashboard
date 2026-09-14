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
}

type managedAggregator struct {
	agg    *Aggregator
	cancel context.CancelFunc
}

// NewManager returns a Manager whose per-user Aggregators refresh every
// refreshInterval.
func NewManager(refreshInterval time.Duration) *Manager {
	return &Manager{users: make(map[string]*managedAggregator), refreshInterval: refreshInterval}
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
		existing.cancel()
	}

	runCtx, cancel := context.WithCancel(ctx)
	agg := NewAggregator(sources)
	m.users[key] = &managedAggregator{agg: agg, cancel: cancel}
	go agg.Run(runCtx, m.refreshInterval)
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

	runCtx, cancel := context.WithCancel(ctx)
	agg := NewAggregator(sources)
	m.users[key] = &managedAggregator{agg: agg, cancel: cancel}
	go agg.Run(runCtx, m.refreshInterval)
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

// RefreshRepo delegates to userID's Aggregator — see
// Aggregator.RefreshRepo. Reports false if userID has no running
// Aggregator, the same as RefreshNow, and also false wherever
// Aggregator.RefreshRepo itself would — a caller should fall back to
// RefreshNow either way, without needing to tell the two apart.
func (m *Manager) RefreshRepo(ctx context.Context, userID []byte, forge Forge, owner, name, fullName string) bool {
	m.mu.Lock()
	entry, ok := m.users[string(userID)]
	m.mu.Unlock()

	if !ok {
		return false
	}
	return entry.agg.RefreshRepo(ctx, forge, owner, name, fullName)
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
