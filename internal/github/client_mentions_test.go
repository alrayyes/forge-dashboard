package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/dashboard"
	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// GitHub reports the closing references itself and nothing else, so the
// client reads the title and description for the tickets a pull request
// mentions without closing.
func TestFetchRepo_CarriesTheMentionedIssueReferences(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		_ = readGraphQLRequest(t, r)
		node := stalePRNode("CLEAN", "head", "head", rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil))
		node["title"] = "Follow up on GH-5"
		node["body"] = "Fixes #12. See #13, alrayyes/b#4 and https://github.com/alrayyes/c/issues/6."
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
	assert.Equal(t, []dashboard.IssueRef{
		{Repo: "alrayyes/a", Number: 5, URL: "https://github.com/alrayyes/a/issues/5"},
		{Repo: "alrayyes/a", Number: 13, URL: "https://github.com/alrayyes/a/issues/13"},
		{Repo: "alrayyes/b", Number: 4, URL: "https://github.com/alrayyes/b/issues/4"},
		{Repo: "alrayyes/c", Number: 6, URL: "https://github.com/alrayyes/c/issues/6"},
	}, prs[0].MentionsIssues)
}
