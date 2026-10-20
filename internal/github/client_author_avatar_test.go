package github_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A webhook refresh swaps one repo's pull requests in for the last full fetch,
// so its query has to read the author's avatar too, or the row loses it.
func TestFetchRepo_CarriesTheAuthorAvatar(t *testing.T) {
	t.Parallel()

	var query string
	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		if q := readGraphQLRequest(t, r).Query; strings.Contains(q, "pullRequests(") {
			query = q
		}
		node := stalePRNode("CLEAN", "head", "head", rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil))
		node["author"] = map[string]any{"login": "claude", "avatarUrl": "https://avatars.example.com/u/1"}
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
	assert.Equal(t, "https://avatars.example.com/u/1", prs[0].AuthorAvatarURL)
	assert.Regexp(t, `pullRequests\(.*?author \{\s*login\s+avatarUrl`, strings.ReplaceAll(query, "\n", " "),
		"the query asks for the avatar, since the mock answers either way")
}
