package github_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

func (m *memHookChecks) PruneUntracked(_ context.Context, forge dashboard.Forge, credential string, repos []string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for key := range m.rows {
		if !strings.HasPrefix(key, string(forge)+"|"+credential+"|") {
			continue
		}
		if !slices.Contains(repos, m.rows[key].Repo) {
			delete(m.rows, key)
		}
	}

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

func TestWebhookEvents_AfterARestart_AnOldSavedCheckIsNotTrusted(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{rows: map[string]dashboard.HookCheck{
		"github|token:ab12|alrayyes/a": {
			Repo: "alrayyes/a", Has: true, Events: []string{"push"},
			CheckedAt: time.Now().Add(-2 * dashboard.HookCheckFreshness),
		},
	}}

	restarted := newCheckingClient("http://127.0.0.1:1", store, "token:ab12")
	_, confirmed := restarted.WebhookEvents("alrayyes/a")

	assert.False(t, confirmed)
}

func TestWebhookEvents_AfterARestart_AFreshSavedCheckIsTrusted(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{rows: map[string]dashboard.HookCheck{
		"github|token:ab12|alrayyes/a": {
			Repo: "alrayyes/a", Has: true, Events: []string{"push"},
			CheckedAt: time.Now().Add(-dashboard.HookCheckFreshness / 2),
		},
	}}

	restarted := newCheckingClient("http://127.0.0.1:1", store, "token:ab12")
	_, confirmed := restarted.WebhookEvents("alrayyes/a")

	assert.True(t, confirmed)
}

func TestFetch_WebhookCheck_AnUnchangedAnswerIsSavedAgainOnceItIsGettingOld(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{rows: map[string]dashboard.HookCheck{
		"github|token:ab12|alrayyes/a": {
			Repo: "alrayyes/a", Has: true, Events: []string{"check_run"},
			CheckedAt: time.Now().Add(-dashboard.HookCheckFreshness * 3 / 4),
		},
	}}
	srv := hookEventsServer(t, []string{"check_run"})

	newCheckingClient(srv.URL, store, "token:ab12").Fetch(t.Context())

	require.Equal(t, 1, store.saveCount())
}

func TestFetch_WebhookCheck_RowsForReposNoLongerTrackedArePruned(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{rows: map[string]dashboard.HookCheck{
		"github|token:ab12|gone/repo":  {Repo: "gone/repo", Has: true, CheckedAt: time.Now()},
		"github|token:cd34|other/repo": {Repo: "other/repo", Has: true, CheckedAt: time.Now()},
	}}
	srv := hookEventsServer(t, []string{"check_run"})

	newCheckingClient(srv.URL, store, "token:ab12").Fetch(t.Context())

	got, err := store.LoadHookChecks(t.Context(), dashboard.ForgeGitHub, "token:ab12")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "alrayyes/a", got[0].Repo)
	other, err := store.LoadHookChecks(t.Context(), dashboard.ForgeGitHub, "token:cd34")
	require.NoError(t, err)
	assert.Len(t, other, 1, "another credential's rows are left alone")
}

func TestWebhookEvents_AfterARestart_ACheckStampedInTheFutureIsNotTrusted(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{rows: map[string]dashboard.HookCheck{
		"github|token:ab12|alrayyes/a": {
			Repo: "alrayyes/a", Has: true, Events: []string{"push"},
			CheckedAt: time.Now().Add(48 * time.Hour),
		},
	}}

	restarted := newCheckingClient("http://127.0.0.1:1", store, "token:ab12")
	_, confirmed := restarted.WebhookEvents("alrayyes/a")

	assert.False(t, confirmed)
}

func TestFetch_WebhookCheck_PruningRunsOncePerIntervalNotEveryPoll(t *testing.T) {
	t.Parallel()
	store := &memHookChecks{}
	srv := hookEventsServer(t, []string{"check_run"})
	client := newCheckingClient(srv.URL, store, "token:ab12")
	client.Fetch(t.Context())
	store.mu.Lock()
	store.rows["github|token:ab12|gone/repo"] = dashboard.HookCheck{Repo: "gone/repo", CheckedAt: time.Now()}
	store.mu.Unlock()

	client.Fetch(t.Context())

	got, err := store.LoadHookChecks(t.Context(), dashboard.ForgeGitHub, "token:ab12")
	require.NoError(t, err)
	assert.Len(t, got, 2, "the second poll is inside the prune interval")
}

func TestFetch_WebhookCheck_ARepoThatLeavesAndReturnsIsSavedAgain(t *testing.T) {
	t.Parallel()
	var repoName atomic.Value
	repoName.Store("a")
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		node := repoNodeWithOwnerName()
		node["name"] = repoName.Load().(string)
		writeJSON(t, w, map[string]any{"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []map[string]any{node},
		}}}})
	})
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{
			{"id": 2, "events": []string{"check_run"}, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	store := &memHookChecks{}
	client := newCheckingClient(srv.URL, store, "token:ab12")
	client.SetHookPruneInterval(time.Nanosecond)

	client.Fetch(t.Context())
	repoName.Store("b")
	client.Fetch(t.Context())
	repoName.Store("a")
	client.Fetch(t.Context())

	require.Equal(t, 3, store.saveCount(), "a, then b, then a again after being pruned")
	got, err := store.LoadHookChecks(t.Context(), dashboard.ForgeGitHub, "token:ab12")
	require.NoError(t, err)
	require.Len(t, got, 1)
	assert.Equal(t, "alrayyes/a", got[0].Repo)
}
