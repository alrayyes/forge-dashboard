package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A webhook refresh swaps one repo's pull requests in for the last full fetch,
// so its query has to read the closing references too, or the list goes empty
// until the next full poll.
func TestFetchRepo_CarriesTheClosingIssueReferences(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "pullRequests(") {
			query = q
		}
		node := stalePRNode("CLEAN", "head", "head", rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil))
		node["closingIssuesReferences"] = map[string]any{"nodes": []map[string]any{
			{"number": 12, "url": "https://github.com/alrayyes/a/issues/12", "repository": map[string]any{"nameWithOwner": "alrayyes/a"}},
		}}
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"repository": map[string]any{
					"pullRequests": map[string]any{"nodes": []map[string]any{node}},
					"issues":       map[string]any{"nodes": []map[string]any{}},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	prs, _, err := github.NewClient("test-token", "", srv.URL).FetchRepo(t.Context(), "alrayyes", "a", "alrayyes/a")

	require.NoError(t, err)
	require.Len(t, prs, 1)
	assert.Equal(t, []dashboard.IssueRef{{Repo: "alrayyes/a", Number: 12, URL: "https://github.com/alrayyes/a/issues/12"}}, prs[0].ClosesIssues)
	assert.Contains(t, query, "closingIssuesReferences", "the query asks for it, since the mock answers either way")
}
