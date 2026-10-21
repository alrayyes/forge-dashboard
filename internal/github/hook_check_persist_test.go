package github_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// memHookChecks is an in-memory HookCheckStore. Its rows outlive any one
// Client, the way the table outlives a restart.
type memHookChecks struct {
	mu    sync.Mutex
	rows  map[string]dashboard.HookCheck
	saves int
}

func (m *memHookChecks) LoadHookChecks(_ context.Context, forge dashboard.Forge, credential string) ([]dashboard.HookCheck, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var out []dashboard.HookCheck
	for key, check := range m.rows {
		if strings.HasPrefix(key, string(forge)+"|"+credential+"|") {
			out = append(out, check)
		}
	}

	return out, nil
}

func (m *memHookChecks) SaveHookCheck(_ context.Context, forge dashboard.Forge, credential string, check dashboard.HookCheck) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string]dashboard.HookCheck{}
	}
	m.rows[string(forge)+"|"+credential+"|"+check.Repo] = check
	m.saves++

	return nil
}

func (m *memHookChecks) saveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()

	return m.saves
}

func newCheckingClient(url string, store dashboard.HookCheckStore, credential string) *github.Client {
	client := github.NewClient("test-token", "", url)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	client.SetStats(apistats.New(), credential)
	client.SetHookCheckStore(store)

	return client
}

func TestWebhookEvents_AfterARestart_AreKnownBeforeTheFirstCheck(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{}
	srv := hookEventsServer(t, []string{"pull_request", "check_run"})
	newCheckingClient(srv.URL, store, "token:ab12").Fetch(t.Context())

	restarted := newCheckingClient("http://127.0.0.1:1", store, "token:ab12")
	events, confirmed := restarted.WebhookEvents("alrayyes/a")

	assert.True(t, confirmed)
	assert.Equal(t, []string{"pull_request", "check_run"}, events)
}

func TestWebhookEvents_AnotherCredential_DoesNotSeeTheSavedChecks(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{}
	srv := hookEventsServer(t, []string{"check_run"})
	newCheckingClient(srv.URL, store, "token:ab12").Fetch(t.Context())

	other := newCheckingClient("http://127.0.0.1:1", store, "token:cd34")
	_, confirmed := other.WebhookEvents("alrayyes/a")

	assert.False(t, confirmed)
}

func TestFetch_WebhookCheck_AnUnchangedAnswerIsNotSavedAgain(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{}
	srv := hookEventsServer(t, []string{"check_run"})
	client := newCheckingClient(srv.URL, store, "token:ab12")

	client.Fetch(t.Context())
	client.Fetch(t.Context())

	require.Equal(t, 1, store.saveCount())
}
