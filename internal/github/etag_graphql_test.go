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

// The ETag cache serves GETs only. The pull request lists come over GraphQL
// POSTs, so a stale cached list can never answer a refresh after a merge
// (#966). Pinned here because the cache sits on the same http.Client.
func TestFetchRepo_NeverAnswersFromTheETagCache(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	var conditional atomic.Bool
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") != "" {
			conditional.Store(true)
			w.WriteHeader(http.StatusNotModified)

			return
		}
		prs := []map[string]any{}
		if calls.Add(1) == 1 {
			prs = append(prs, map[string]any{"number": 78, "title": "open", "labels": map[string]any{"nodes": []map[string]any{}}})
		}
		w.Header().Set("ETag", `"same-for-both"`)
		writeJSON(t, w, map[string]any{"data": map[string]any{"repository": map[string]any{
			"pullRequests": map[string]any{"nodes": prs},
			"issues":       map[string]any{"nodes": []map[string]any{}},
		}}})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	client := github.NewClient("test-token", "", srv.URL)

	first, _, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)
	require.Len(t, first, 1)

	second, _, err := client.FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")
	require.NoError(t, err)

	assert.Empty(t, second, "the second answer is the forge's current one")
	assert.False(t, conditional.Load(), "a GraphQL POST is never sent conditionally")
}
