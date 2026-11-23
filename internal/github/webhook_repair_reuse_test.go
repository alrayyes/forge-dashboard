package github_test

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const repairTarget = "https://dashboard.example/api/webhooks/github/tok123"

var allHookEvents = []string{
	"check_run", "status", "pull_request_review_thread", "pull_request_review_comment",
	"pull_request_review", "issue_comment", "issues", "pull_request", "push",
}

// repairServer answers one repo's poll and counts the hooks reads and writes
// made against it (#4687).
func repairServer(t *testing.T, active bool, events []string) (srv *httptest.Server, lists, patches *atomic.Int32) {
	t.Helper()

	lists, patches = new(atomic.Int32), new(atomic.Int32)
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
		lists.Add(1)
		writeJSON(t, w, []map[string]any{
			{"id": 7, "events": events, "active": active, "config": map[string]any{"url": repairTarget}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks/7", func(w http.ResponseWriter, _ *http.Request) {
		patches.Add(1)
		writeJSON(t, w, map[string]any{"id": 7})
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv, lists, patches
}

func TestUpgradeWebhook_AfterAProbeSawAnActiveHook_ReadsNoHooksAgain(t *testing.T) {
	t.Parallel()

	srv, lists, _ := repairServer(t, true, allHookEvents)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	client.Fetch(t.Context())
	require.EqualValues(t, 1, lists.Load(), "the probe reads the hooks once")

	_, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.EqualValues(t, 1, lists.Load(), "the repair reuses what the probe read")
}

func TestUpgradeWebhook_AfterAProbeSawAnInactiveHook_PatchesOnceWithoutReading(t *testing.T) {
	t.Parallel()

	srv, lists, patches := repairServer(t, false, allHookEvents)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")
	client.Fetch(t.Context())

	updated, err := client.UpgradeWebhook(t.Context(), "alrayyes", "a", repairTarget, "sekret")

	require.NoError(t, err)
	assert.True(t, updated)
	assert.EqualValues(t, 1, patches.Load())
	assert.EqualValues(t, 1, lists.Load())
}
