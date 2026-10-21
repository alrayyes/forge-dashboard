package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Through an Aggregator, every call a refresh makes lands under a named kind.
// A call under "unknown" means a new path went uncounted by reason.
func TestAggregatorRefresh_LeavesNoCallUnderUnknown(t *testing.T) {
	t.Parallel()

	repo := map[string]any{
		"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": "alrayyes"},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issues":       map[string]any{"nodes": []map[string]any{}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 2, "remaining": 4998, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
				"nodes":    []map[string]any{repo},
			}},
			"repository": repo,
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	counters := apistats.New()
	client := github.NewClient("test-token", "", srv.URL)
	client.SetStats(counters, "token:abcd")
	client.SetWebhookPath("/api/webhooks/github/tok123")
	agg := dashboard.NewAggregator([]dashboard.Source{client})

	agg.Refresh(t.Context())
	require.True(t, agg.RefreshRepo(t.Context(), dashboard.ForgeGitHub, "alrayyes", "a", "alrayyes/a"))

	kinds := map[apistats.Kind]int64{}
	for _, b := range counters.Snapshot() {
		kinds[b.Kind] += b.REST + b.GraphQL + b.NotModified
	}
	assert.Zero(t, kinds[apistats.KindUnknown], "calls nobody tagged: %v", kinds)
	assert.Positive(t, kinds[apistats.KindFull])
	assert.Positive(t, kinds[apistats.KindScopedWebhook])
	assert.Positive(t, kinds[apistats.KindHookMaintenance])
	assert.Positive(t, kinds[apistats.KindAdvisories])
}

func TestFetch_ReportsWhatTheFetchItselfSpent(t *testing.T) {
	t.Parallel()

	repo := map[string]any{
		"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "WRITE",
		"owner":        map[string]any{"login": "alrayyes"},
		"pullRequests": map[string]any{"nodes": []map[string]any{}},
		"issues":       map[string]any{"nodes": []map[string]any{}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit": map[string]any{"limit": 5000, "cost": 7, "remaining": 4993, "resetAt": "2026-09-14T16:00:00Z"},
			"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false, "endCursor": ""},
				"nodes":    []map[string]any{repo},
			}},
		}})
	})
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := github.NewClient("test-token", "", srv.URL)
	client.SetStats(apistats.New(), "token:abcd")
	client.SetWebhookPath("/api/webhooks/github/tok123")

	result := client.Fetch(t.Context())

	require.NotNil(t, result.Spent)
	assert.Equal(t, 7, result.Spent.GraphQL)
	assert.Equal(t, 2, result.Spent.REST, "the hook check and the advisories read")
}

func TestFetch_WithoutStats_ReportsNoSpend(t *testing.T) {
	t.Parallel()

	client := github.NewClient("", "", "http://127.0.0.1:1")

	assert.Nil(t, client.Fetch(t.Context()).Spent)
}
