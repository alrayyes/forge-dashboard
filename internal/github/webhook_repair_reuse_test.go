package github_test

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	repairTarget = "https://dashboard.example/api/webhooks/github/tok123"
	repairPath   = "/api/webhooks/github/tok123"
)

var allHookEvents = []string{
	"check_run", "status", "pull_request_review_thread", "pull_request_review_comment",
	"pull_request_review", "issue_comment", "issues", "pull_request", "push",
}

// fakeHooks is one repo's hooks as a forge answers them, counting the reads and
// writes made against it (#4687). The hook it serves can change between calls.
type fakeHooks struct {
	srv     *httptest.Server
	lists   atomic.Int32
	patches atomic.Int32

	mu      sync.Mutex
	id      int64 // 0 serves no hook of ours
	active  bool
	events  []string
	patched []int64 // ids a PATCH reached, in order
}

func (f *fakeHooks) serve(id int64, active bool, events []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.id, f.active, f.events = id, active, events
}

func (f *fakeHooks) patchedIDs() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()

	return append([]int64(nil), f.patched...)
}

func newFakeHooks(t *testing.T, id int64, active bool, events []string) *fakeHooks {
	t.Helper()

	f := &fakeHooks{id: id, active: active, events: events}
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName()},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		f.lists.Add(1)
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.id == 0 {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"id": f.id, "events": f.events, "active": f.active, "config": map[string]any{"url": repairTarget}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks/", func(w http.ResponseWriter, r *http.Request) {
		f.patches.Add(1)
		f.mu.Lock()
		defer f.mu.Unlock()
		id, err := strconv.ParseInt(r.URL.Path[len("/repos/alrayyes/a/hooks/"):], 10, 64)
		assert.NoError(t, err)
		f.patched = append(f.patched, id)
		if id != f.id {
			http.NotFound(w, r)

			return
		}
		f.active, f.events = true, allHookEvents
		writeJSON(t, w, map[string]any{
			"id": id, "events": allHookEvents, "active": true, "config": map[string]any{"url": repairTarget},
		})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)

	return f
}

func (f *fakeHooks) probedClient(t *testing.T) *github.Client {
	t.Helper()

	client := github.NewClient("test-token", "", f.srv.URL)
	client.SetWebhookPath(repairPath)
	client.Fetch(t.Context())
	require.EqualValues(t, 1, f.lists.Load(), "the probe reads the hooks once")

	return client
}

func TestUpgradeWebhook_AfterAProbeSawAnActiveHook_ReadsNoHooksAgain(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, true, allHookEvents)
	client := f.probedClient(t)

	_, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.EqualValues(t, 1, f.lists.Load(), "the repair reuses what the probe read")
}

func TestUpgradeWebhook_AfterAProbeSawAnInactiveHook_PatchesOnceWithoutReading(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, false, allHookEvents)
	client := f.probedClient(t)

	updated, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.True(t, updated)
	assert.EqualValues(t, 1, f.patches.Load())
	assert.EqualValues(t, 1, f.lists.Load())
}

func TestUpgradeWebhook_NoProbeYet_ListsOnceAndRepairs(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, false, allHookEvents)
	client := github.NewClient("test-token", "", f.srv.URL)
	client.SetWebhookPath(repairPath)

	updated, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.True(t, updated)
	assert.EqualValues(t, 1, f.lists.Load())
}

func TestUpgradeWebhook_TargetPathDiffersFromTheProbes_ListsInstead(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, true, allHookEvents)
	client := f.probedClient(t)

	_, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", "https://dashboard.example/api/webhooks/github/other", "sekret")

	require.NoError(t, err)
	assert.EqualValues(t, 2, f.lists.Load())
}

func TestUpgradeWebhook_HookRecreatedSinceTheProbe_RepairsTheNewOne(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, false, allHookEvents)
	client := f.probedClient(t)
	f.serve(9, false, allHookEvents)

	updated, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.True(t, updated)
	assert.Equal(t, []int64{7, 9}, f.patchedIDs(), "the stale id is refused, then the listed one is patched")
}

func TestUpgradeWebhook_HookDeletedSinceTheProbe_DoesNothingAndForgetsIt(t *testing.T) {
	t.Parallel()

	f := newFakeHooks(t, 7, false, allHookEvents)
	client := f.probedClient(t)
	f.serve(0, false, nil)

	updated, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.False(t, updated)
	assert.EqualValues(t, 2, f.lists.Load())
}
