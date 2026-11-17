package dashboard

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

type capCancelSource struct {
	forge Forge
	prs   []PullRequest

	mu       sync.Mutex
	disabled int
}

func (s *capCancelSource) Fetch(context.Context) Result {
	return Result{Health: ForgeHealth{Forge: s.forge, Reachable: true}, PullRequests: s.prs}
}

func (s *capCancelSource) Forge() Forge { return s.forge }

func (s *capCancelSource) DisableAutoMerge(context.Context, string, string, int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.disabled++

	return nil
}

type capCancelStore struct {
	AutoMergeStore
	armed     map[string]struct{}
	cancelled []string
}

func (s *capCancelStore) AutoMergeIntents(context.Context) (map[string]struct{}, error) {
	return s.armed, nil
}

func (s *capCancelStore) CancelAutoMerge(_ context.Context, forge, _ string, _ int) error {
	s.cancelled = append(s.cancelled, forge)

	return nil
}

func TestCancelEmptyAutoMerge_FollowsTheCapabilityNotTheForgeName(t *testing.T) {
	// Not parallel: it edits the shared capability table.
	heldByApp := Forge("heldforge")
	heldByForge := Forge("selfforge")
	withForge(t, heldByApp, ForgeCapabilities{AutoMergeHeldByApp: true})
	withForge(t, heldByForge, ForgeCapabilities{AutoMergeHeldByApp: false})

	on := true
	at := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	appPR := PullRequest{Forge: heldByApp, Repo: "o/a", Number: 1, Empty: true, UpdatedAt: at}
	forgePR := PullRequest{Forge: heldByForge, Repo: "o/b", Number: 2, Empty: true, AutoMergeEnabled: &on, UpdatedAt: at}

	appSrc := &capCancelSource{forge: heldByApp, prs: []PullRequest{appPR}}
	forgeSrc := &capCancelSource{forge: heldByForge, prs: []PullRequest{forgePR}}
	store := &capCancelStore{armed: map[string]struct{}{dependabotPRKey(appPR): {}}}

	agg := NewAggregator([]Source{appSrc, forgeSrc})
	agg.EnableAutoMerge(store)
	agg.Refresh(t.Context())

	assert.Equal(t, []string{"heldforge"}, store.cancelled, "the app drops its own intent for an app-held forge")
	assert.Equal(t, 1, forgeSrc.disabled, "a forge-held auto-merge is turned off on the forge")
	assert.Zero(t, appSrc.disabled)
}
