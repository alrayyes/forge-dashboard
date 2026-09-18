package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestHasWebhook_RepeatCall_SendsIfNoneMatchOnceETagIsKnown is #381's own
// acceptance criterion for this client's REST calls: a repeat request for
// data GitHub already served once should offer back the ETag it got, so
// an unchanged response can come back as a free 304 instead of a full,
// budget-costing 200.
func TestHasWebhook_RepeatCall_SendsIfNoneMatchOnceETagIsKnown(t *testing.T) {
	t.Parallel()

	var requests []*http.Request
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r)
		if inm := r.Header.Get("If-None-Match"); inm != "" {
			assert.Equal(t, `"abc123"`, inm)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"abc123"`)
		writeJSON(t, w, []map[string]any{
			{"id": 1, "config": map[string]any{"url": "https://dashboard.example/api/webhooks/github/tok123"}},
		})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	has, err := client.HasWebhook(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	assert.True(t, has, "first call: a real 200 body with the matching hook")

	has, err = client.HasWebhook(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	assert.True(t, has, "second call: a 304 served from the cached body, same answer")

	require.Len(t, requests, 2)
	assert.Empty(t, requests[0].Header.Get("If-None-Match"), "nothing cached yet for the first request")
	assert.Equal(t, `"abc123"`, requests[1].Header.Get("If-None-Match"))
}

// TestHasWebhook_ResponseWithoutETag_NeverCached is the same shape as
// recordRESTRate ignoring a zero Rate: a response that doesn't play along
// with conditional requests at all (no ETag) can't be cached, so nothing
// here should ever synthesize an If-None-Match out of thin air.
func TestHasWebhook_ResponseWithoutETag_NeverCached(t *testing.T) {
	t.Parallel()

	var requests []*http.Request
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r)
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	_, err := client.HasWebhook(t.Context(), "alrayyes", "a")
	require.NoError(t, err)
	_, err = client.HasWebhook(t.Context(), "alrayyes", "a")
	require.NoError(t, err)

	require.Len(t, requests, 2)
	assert.Empty(t, requests[0].Header.Get("If-None-Match"))
	assert.Empty(t, requests[1].Header.Get("If-None-Match"), "no ETag was ever offered, so nothing should have been cached")
}

// TestFetch_RepeatPoll_304OnHooksStillReportsFreshRateLimit is the whole
// point of caching at all: GitHub itself doesn't charge a 304 against the
// REST budget, so the second poll's own X-RateLimit-Remaining — lower
// than the first's real 200, since other REST calls happened between
// polls — has to reach ForgeHealth same as always, not get shadowed by
// whatever the first, now-cached response's headers said.
func TestFetch_RepeatPoll_304OnHooksStillReportsFreshRateLimit(t *testing.T) {
	t.Parallel()

	call := 0
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes":    []map[string]any{repoNodeWithOwnerName("alrayyes", "a")},
					},
				},
			},
		})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		call++
		if inm := r.Header.Get("If-None-Match"); inm != "" {
			w.Header().Set("X-RateLimit-Limit", "5000")
			w.Header().Set("X-RateLimit-Remaining", "4000")
			w.Header().Set("X-RateLimit-Reset", "1789400145")
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"hooks-etag"`)
		w.Header().Set("X-RateLimit-Limit", "5000")
		w.Header().Set("X-RateLimit-Remaining", "4999")
		w.Header().Set("X-RateLimit-Reset", "1789400145")
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath("/api/webhooks/github/tok123")

	first := client.Fetch(t.Context())
	require.NotNil(t, first.Health.RateLimitREST)
	assert.Equal(t, 4999, first.Health.RateLimitREST.Remaining)

	second := client.Fetch(t.Context())
	require.NotNil(t, second.Health.RateLimitREST)
	assert.Equal(t, 4000, second.Health.RateLimitREST.Remaining, "the second poll's own fresh headers, not the cached first response's")
	assert.Equal(t, 2, call, "both polls should have reached the server — a 304 still counts as a real round trip, just a free one")
}
