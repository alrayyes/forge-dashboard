package dashboard_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type memSeenStore struct {
	mu    sync.Mutex
	rows  map[string]dashboard.SeenRecord
	saves int
}

func (m *memSeenStore) LoadWebhookSeen(_ context.Context, forge dashboard.Forge, credential string) ([]dashboard.SeenRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []dashboard.SeenRecord
	for key, rec := range m.rows {
		if strings.HasPrefix(key, string(forge)+"|"+credential+"|") {
			out = append(out, rec)
		}
	}

	return out, nil
}

func (m *memSeenStore) SaveWebhookSeen(_ context.Context, forge dashboard.Forge, credential string, rec dashboard.SeenRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string]dashboard.SeenRecord{}
	}
	m.rows[string(forge)+"|"+credential+"|"+rec.Repo+"|"+string(rec.Class)] = rec
	m.saves++

	return nil
}

// tokenSource names its credential, the way a GitHub client does.
type tokenSource struct{ *flakySource }

func (tokenSource) CredentialLabel() string { return "token:ab12" }

func TestAggregator_AfterARestart_RemembersWhenDeliveriesLastArrived(t *testing.T) {
	t.Parallel()
	store := &memSeenStore{}
	at := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	source := func() dashboard.Source { return tokenSource{&flakySource{forge: dashboard.ForgeGitHub}} }
	before := dashboard.NewAggregator([]dashboard.Source{source()},
		dashboard.WithWebhookSeenStore(store), dashboard.WithClock(func() time.Time { return at }))
	before.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")
	before.RecordCheckDelivery(dashboard.ForgeGitHub, "o/r", "abc")

	after := dashboard.NewAggregator([]dashboard.Source{source()}, dashboard.WithWebhookSeenStore(store))

	got, seen := after.LastDelivery(dashboard.ForgeGitHub, "o/r", dashboard.EventClassCheck)
	require.True(t, seen)
	assert.True(t, at.Equal(got))
	_, otherSeen := after.LastDelivery(dashboard.ForgeGitHub, "o/r", dashboard.EventClassOther)
	assert.False(t, otherSeen, "a class that never arrived stays unseen")
}

func (m *memSeenStore) saveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.saves
}

func TestAggregator_ADeliveryForARepoSeenAMomentAgoIsNotWrittenAgain(t *testing.T) {
	t.Parallel()
	store := &memSeenStore{}
	now := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	agg := dashboard.NewAggregator([]dashboard.Source{tokenSource{&flakySource{forge: dashboard.ForgeGitHub}}},
		dashboard.WithWebhookSeenStore(store), dashboard.WithClock(func() time.Time { return now }))

	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")
	now = now.Add(5 * time.Second)
	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")

	assert.Equal(t, 1, store.saveCount())
	got, _ := agg.LastDelivery(dashboard.ForgeGitHub, "o/r", dashboard.EventClassCheck)
	assert.True(t, now.Equal(got), "the in-memory time still moves")
}

func TestAggregator_ADeliveryLongAfterTheLastIsWritten(t *testing.T) {
	t.Parallel()
	store := &memSeenStore{}
	now := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	agg := dashboard.NewAggregator([]dashboard.Source{tokenSource{&flakySource{forge: dashboard.ForgeGitHub}}},
		dashboard.WithWebhookSeenStore(store), dashboard.WithClock(func() time.Time { return now }))

	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")
	now = now.Add(10 * time.Minute)
	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")

	assert.Equal(t, 2, store.saveCount())
}

func TestAggregator_ADeliveryOfAnotherClassIsWritten(t *testing.T) {
	t.Parallel()
	store := &memSeenStore{}
	now := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	agg := dashboard.NewAggregator([]dashboard.Source{tokenSource{&flakySource{forge: dashboard.ForgeGitHub}}},
		dashboard.WithWebhookSeenStore(store), dashboard.WithClock(func() time.Time { return now }))

	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")
	agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "pull_request")

	assert.Equal(t, 2, store.saveCount())
}

func TestAggregator_ASteadyStreamOfDeliveriesStillReachesTheStore(t *testing.T) {
	t.Parallel()
	store := &memSeenStore{}
	now := time.Date(2026, 10, 21, 9, 0, 0, 0, time.UTC)
	agg := dashboard.NewAggregator([]dashboard.Source{tokenSource{&flakySource{forge: dashboard.ForgeGitHub}}},
		dashboard.WithWebhookSeenStore(store), dashboard.WithClock(func() time.Time { return now }))

	for range 8 {
		agg.RecordDelivery(dashboard.ForgeGitHub, "o/r", "check_run")
		now = now.Add(30 * time.Second)
	}

	assert.Equal(t, 4, store.saveCount(), "one write a minute, never none while deliveries keep coming")
}
