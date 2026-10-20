package github_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/apistats"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func statsRow(counters *apistats.Counters, key apistats.Key) apistats.Count {
	for _, b := range counters.Snapshot() {
		if b.Key == key {
			return b.Count
		}
	}

	return apistats.Count{}
}

func TestSetStats_GraphQLCallIsCountedWithItsCostUnderKindAndRepo(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{"data": map[string]any{
			"rateLimit":  map[string]any{"limit": 5000, "cost": 3, "remaining": 4997},
			"repository": map[string]any{"pullRequests": map[string]any{"nodes": []map[string]any{}}, "issues": map[string]any{"nodes": []map[string]any{}}},
		}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	counters := apistats.New()
	client := github.NewClient("test-token", "", srv.URL)
	client.SetStats(counters, "token:abcd")

	ctx := apistats.WithRepo(apistats.WithKind(context.Background(), apistats.KindScopedWebhook), "alrayyes/a")
	_, _, err := client.FetchRepo(ctx, "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)

	got := statsRow(counters, apistats.Key{Forge: "github", Credential: "token:abcd", Kind: apistats.KindScopedWebhook, Repo: "alrayyes/a"})
	assert.EqualValues(t, 1, got.GraphQL)
	assert.EqualValues(t, 3, got.GraphQLCost)
}

func TestSetStats_AnswerFromTheETagCacheIsCountedAsNotModified(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/alrayyes/a/hooks", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "" {
			w.WriteHeader(http.StatusNotModified)

			return
		}
		w.Header().Set("ETag", `"abc123"`)
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	counters := apistats.New()
	client := github.NewClient("test-token", "", srv.URL)
	client.SetStats(counters, "token:abcd")
	client.SetWebhookPath("/api/webhooks/github/tok123")

	ctx := apistats.WithKind(context.Background(), apistats.KindHookMaintenance)
	_, err := client.HasWebhook(ctx, "alrayyes", "a")
	require.NoError(t, err)
	_, err = client.HasWebhook(ctx, "alrayyes", "a")
	require.NoError(t, err)

	got := statsRow(counters, apistats.Key{Forge: "github", Credential: "token:abcd", Kind: apistats.KindHookMaintenance, Repo: "alrayyes/a"})
	assert.EqualValues(t, 1, got.REST, "the first call was a full 200")
	assert.EqualValues(t, 1, got.NotModified, "the repeat came back 304 and is not charged as REST")
}

func TestClientWithoutStats_StillWorks(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	}))
	defer srv.Close()
	client := github.NewClient("test-token", "", srv.URL)
	client.SetStats(nil, "token:abcd")

	_, err := client.HasWebhook(t.Context(), "alrayyes", "a")
	assert.NoError(t, err)
}
