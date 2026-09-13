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
