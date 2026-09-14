package dashboard_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestManager_ConcurrentRefreshTriggersForSameUser_DoNotEachHitTheRealAPI is
// a regression test for a real incident: forge-dashboard's GitHub account
// burned through its entire 5000/hour REST budget in under a minute,
// repeatedly. Nothing in Aggregator.Refresh or Manager.RefreshNow
// prevents two overlapping triggers for the same user — a webhook
// delivery, a scheduled tick, another webhook — from each running their
// own full fetch against the real API concurrently. This drives a real
// github.Client against a real httptest.Server counting POST /graphql
// calls, rather than asserting on the code's shape, so it proves the
// actual number of requests a burst of concurrent triggers produces.
func TestManager_ConcurrentRefreshTriggersForSameUser_DoNotEachHitTheRealAPI(t *testing.T) {
	t.Parallel()

	var calls atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 4999, "resetAt": "2026-09-14T20:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	// An hour-long ticker means the only refreshes in this test are the
	// one Ensure triggers immediately and the ones the test fires itself
	// — nothing from the background schedule racing in unpredictably.
	manager := dashboard.NewManager(time.Hour)
	t.Cleanup(manager.Stop)

	userID := []byte("user-1")
	manager.Ensure(t.Context(), userID, []dashboard.Source{client})

	require.Eventually(t, func() bool { return calls.Load() >= 1 }, time.Second, 5*time.Millisecond,
		"Ensure's own initial refresh should have completed")
	before := calls.Load()

	// Simulate several overlapping triggers landing at once — two
	// webhook deliveries and a third caller, all for the same user.
	const triggers = 5
	var wg sync.WaitGroup
	for range triggers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			manager.RefreshNow(t.Context(), userID)
		}()
	}
	wg.Wait()

	// At most 2, not 1: whichever trigger acquires the in-flight slot
	// causes one fetch, and every other trigger that arrives before that
	// fetch finishes coalesces into a single trailing fetch guaranteed to
	// start after it arrived (Aggregator.Refresh's own doc comment) —
	// never one full fetch per trigger, which is the actual regression
	// this guards against.
	assert.LessOrEqual(t, calls.Load()-before, int64(2),
		"concurrent refresh triggers for the same user should coalesce into at most one in-flight plus one trailing request, not one per trigger")
}
