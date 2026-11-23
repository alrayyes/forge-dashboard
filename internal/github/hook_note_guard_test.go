package github

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNoteOwnHook_ReadOlderThanTheEntry_IsIgnored(t *testing.T) {
	t.Parallel()

	c := &Client{}
	now := time.Now()
	require.True(t, c.noteOwnHook("o/r", &hookProbe{has: true, id: 7, active: true}, now))

	applied := c.noteOwnHook("o/r", &hookProbe{has: true, id: 7, active: false}, now.Add(-time.Second))

	assert.False(t, applied)
	assert.True(t, c.ownHookSeen["o/r"].active, "the older read left the newer answer alone")
}

func TestNoteOwnHook_ReadNewerThanTheEntry_Replaces(t *testing.T) {
	t.Parallel()

	c := &Client{}
	now := time.Now()
	require.True(t, c.noteOwnHook("o/r", &hookProbe{has: true, id: 7, active: true}, now))

	applied := c.noteOwnHook("o/r", &hookProbe{has: true, id: 7, active: false}, now.Add(time.Second))

	assert.True(t, applied)
	assert.False(t, c.ownHookSeen["o/r"].active)
}

// saveCountingStore counts the checks saved to it.
type saveCountingStore struct {
	mu    sync.Mutex
	saves int
}

func (s *saveCountingStore) LoadHookChecks(context.Context, dashboard.Forge, string) ([]dashboard.HookCheck, error) {
	return nil, nil
}

func (s *saveCountingStore) SaveHookCheck(context.Context, dashboard.Forge, string, dashboard.HookCheck) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saves++

	return nil
}

func (s *saveCountingStore) PruneUntracked(context.Context, dashboard.Forge, string, []string) error {
	return nil
}

func TestProbeOwnHook_ReadOlderThanARepair_DoesNotSaveItsCheck(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		assert.NoError(t, json.NewEncoder(w).Encode([]map[string]any{
			{"id": 7, "active": false, "config": map[string]any{"url": "https://dashboard.example/hook"}},
		}))
	}))
	t.Cleanup(srv.Close)
	store := &saveCountingStore{}
	c := NewClient("test-token", "", srv.URL)
	c.SetWebhookPath("/hook")
	c.SetHookCheckStore(store)
	// A repair answered after this probe started reading.
	require.True(t, c.noteOwnHook("o/r", &hookProbe{has: true, id: 7, active: true}, time.Now().Add(time.Hour)))

	c.probeOwnHook(t.Context(), "o", "r")

	store.mu.Lock()
	defer store.mu.Unlock()
	assert.Zero(t, store.saves, "the stale answer isn't persisted over the repair's")
}
