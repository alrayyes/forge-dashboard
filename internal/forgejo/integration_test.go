package forgejo_test

import (
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
