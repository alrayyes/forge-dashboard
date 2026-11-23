package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// #4687's third acceptance criterion: with every covered repo's hook active
// and subscribed to every event, the hourly pass costs no hooks read at all.
func TestUpgradeWebhook_ManyCoveredRepos_ReadsNoHooksBeyondTheProbes(t *testing.T) {
	t.Parallel()

	const repos = 500
	var lists atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, _ *http.Request) {
		nodes := make([]map[string]any, 0, repos)
		for i := range repos {
			node := repoNodeWithOwnerName()
			node["name"] = fmt.Sprintf("r%d", i)
			nodes = append(nodes, node)
		}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{"viewer": map[string]any{"repositories": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": false},
				"nodes":    nodes,
			}}},
		})
	})
	mux.HandleFunc("/repos/alrayyes/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/hooks") {
			http.NotFound(w, r)

			return
		}
		lists.Add(1)
		writeJSON(t, w, []map[string]any{
			{"id": 7, "events": allHookEvents, "active": true, "config": map[string]any{"url": repairTarget}},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := github.NewClient("test-token", "", srv.URL)
	client.SetWebhookPath(repairPath)
	client.Fetch(t.Context())
	require.EqualValues(t, repos, lists.Load(), "one probe read per repo")

	for i := range repos {
		_, err := client.UpgradeWebhook(t.Context(), "alrayyes", fmt.Sprintf("r%d", i), repairTarget, "sekret")
		require.NoError(t, err)
	}

	assert.EqualValues(t, repos, lists.Load(), "the repairs read nothing more")
}
