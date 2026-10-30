package github_test

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// suiteServer answers the follow-up read of check suites: every suite has one
// check run, except "BIG", which says it has a second page. It records how many
// ids each request carried.
func suiteServer(t *testing.T) (*github.Client, func() []int) {
	t.Helper()

	var mu sync.Mutex
	var sizes []int
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		ids := readGraphQLRequest(t, r).Variables["ids"].([]any)
		mu.Lock()
		sizes = append(sizes, len(ids))
		mu.Unlock()
		nodes := []map[string]any{}
		for _, id := range ids {
			nodes = append(nodes, map[string]any{"id": id, "checkRuns": map[string]any{
				"pageInfo": map[string]any{"hasNextPage": id == "BIG"},
				"nodes":    []map[string]any{{"__typename": "CheckRun", "databaseId": 1, "name": "lint"}},
			}})
		}
		writeJSON(t, w, map[string]any{"data": map[string]any{"nodes": nodes}})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return github.NewClient("test-token", "", srv.URL), func() []int {
		mu.Lock()
		defer mu.Unlock()

		return sizes
	}
}

// GitHub refuses more than 100 ids in one nodes(ids:) query.
func TestReadSuiteChecks_AsksForNoMoreThan100SuitesAtATime(t *testing.T) {
	t.Parallel()

	client, sizes := suiteServer(t)
	ids := make([]string, 250)
	for i := range ids {
		ids[i] = fmt.Sprintf("S%d", i)
	}

	counts, _ := client.ReadSuiteChecks(t.Context(), ids)

	assert.Equal(t, []int{100, 100, 50}, sizes())
	assert.Len(t, counts, 250, "every suite is read")
}

// A suite with more jobs than one page is flagged, not silently cut.
func TestReadSuiteChecks_FlagsASuiteWithMoreJobsThanItRead(t *testing.T) {
	t.Parallel()

	client, _ := suiteServer(t)

	_, more := client.ReadSuiteChecks(t.Context(), []string{"SMALL", "BIG"})

	require.Contains(t, more, "BIG")
	assert.True(t, more["BIG"])
	assert.False(t, more["SMALL"])
}
