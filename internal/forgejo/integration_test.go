package forgejo_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/forgejo"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestClient_SatisfiesGenericSource proves the real Client can drive a
// dashboard.GenericSource end to end — see the identical test in
// internal/github for why this doesn't re-test the concurrency logic
// itself.
func TestClient_SatisfiesGenericSource(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{
			{"full_name": "alrayyes/a", "name": "a", "owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true}},
		})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/pulls", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		writeJSON(t, w, []map[string]any{{"number": 1, "title": "x", "html_url": "https://x", "user": map[string]string{"login": "u"}}})
	})
	mux.HandleFunc("/api/v1/repos/alrayyes/a/issues", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, []map[string]any{})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency)

	result := source.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	assert.Equal(t, 1, result.Health.RepoCount)
	assert.Len(t, result.PullRequests, 1)
}

// TestClient_ConcurrentPerRepoFetches_EachRepoGetsItsOwnPulls is a
// regression test for a gitea-sdk-specific risk: the SDK carries its
// request context as one client-wide field (Client.SetContext) rather
// than a parameter on each call, set immediately before every request
// this Client makes. GenericSource.Fetch fetches every repo concurrently
// on goroutines sharing this one Client — if setting that shared field
// ever raced across repos, one repo's request could run against another
// repo's URL/response, mixing their results up. Run with -race and
// enough repos that the scheduler actually interleaves them.
func TestClient_ConcurrentPerRepoFetches_EachRepoGetsItsOwnPulls(t *testing.T) {
	t.Parallel()

	const repoCount = 12
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/user/repos", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			writeJSON(t, w, []map[string]any{})

			return
		}
		var batch []map[string]any
		for i := range repoCount {
			name := fmt.Sprintf("repo-%d", i)
			batch = append(batch, map[string]any{
				"full_name": "alrayyes/" + name, "name": name,
				"owner": map[string]string{"login": "alrayyes"}, "permissions": map[string]bool{"push": true},
			})
		}
		writeJSON(t, w, batch)
	})
	for i := range repoCount {
		name := fmt.Sprintf("repo-%d", i)
		prTitle := "pr for " + name
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/%s/pulls", name), func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Query().Get("page") != "1" {
				writeJSON(t, w, []map[string]any{})

				return
			}
			writeJSON(t, w, []map[string]any{{"number": 1, "title": prTitle, "html_url": "https://x", "user": map[string]string{"login": "u"}}})
		})
		mux.HandleFunc(fmt.Sprintf("/api/v1/repos/alrayyes/%s/issues", name), func(w http.ResponseWriter, _ *http.Request) {
			writeJSON(t, w, []map[string]any{})
		})
	}
	srv := httptest.NewServer(mux)
	defer srv.Close()

	client := forgejo.NewClient(srv.URL, "test-token", "")
	source := dashboard.NewGenericSource(dashboard.ForgeForgejo, client, dashboard.DefaultMaxConcurrency)

	result := source.Fetch(t.Context())

	require.True(t, result.Health.Reachable)
	require.Len(t, result.PullRequests, repoCount)
	for _, pr := range result.PullRequests {
		assert.Equal(t, "pr for "+pr.Repo[len("alrayyes/"):], pr.Title,
			"a pull request's title should match its own repo, not a sibling's fetched concurrently")
	}
}
