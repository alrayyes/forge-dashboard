package github_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/alrayyes/forge-dashboard/internal/github"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func branchCommit(name, login string) map[string]any {
	author := map[string]any{"name": name}
	if login != "" {
		author["user"] = map[string]any{"login": login}
	}

	return map[string]any{"commit": map[string]any{"author": author}}
}

// editedBranchServer serves one pull request by prAuthor whose branch holds
// the given commits (total says how many the branch has).
func editedBranchServer(t *testing.T, prAuthor string, total int, commits ...map[string]any) *httptest.Server {
	t.Helper()

	node := stalePRNode("BEHIND", "head", "head", rollupFixture("SUCCESS", map[string]int{"SUCCESS": 1}, nil))
	node["author"] = map[string]any{"login": prAuthor}
	node["branchCommits"] = map[string]any{"totalCount": total, "nodes": commits}

	mux := http.NewServeMux()
	mux.HandleFunc("/graphql", func(w http.ResponseWriter, r *http.Request) {
		_ = readGraphQLRequest(t, r)
		writeJSON(t, w, map[string]any{
			"data": map[string]any{
				"rateLimit": map[string]any{"limit": 5000, "remaining": 5000, "resetAt": "2026-09-14T16:00:00Z"},
				"viewer": map[string]any{
					"repositories": map[string]any{
						"pageInfo": map[string]any{"hasNextPage": false},
						"nodes": []map[string]any{{
							"name": "a", "isArchived": false, "isFork": false, "viewerPermission": "ADMIN",
							"owner":        map[string]any{"login": "alrayyes"},
							"pullRequests": map[string]any{"nodes": []map[string]any{node}},
							"issues":       map[string]any{"nodes": []map[string]any{}},
						}},
					},
				},
			},
		})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	return srv
}

// Dependabot refuses to rebase a branch with a commit it didn't make, so the
// row says whether the branch has one (#4023).
func TestFetch_DependabotBranchWithAnotherAuthorsCommit_IsEditedByOthers(t *testing.T) {
	t.Parallel()

	for name, tc := range map[string]struct {
		author  string
		total   int
		commits []map[string]any
		want    bool
	}{
		"only Dependabot's own commit":   {"dependabot", 1, []map[string]any{branchCommit("dependabot[bot]", "dependabot[bot]")}, false},
		"a bot's commit on top":          {"dependabot", 2, []map[string]any{branchCommit("dependabot[bot]", "dependabot[bot]"), branchCommit("github-actions[bot]", "github-actions[bot]")}, true},
		"a person's commit on top":       {"dependabot", 2, []map[string]any{branchCommit("dependabot[bot]", "dependabot[bot]"), branchCommit("Ryan", "alrayyes")}, true},
		"an author with no account":      {"dependabot", 2, []map[string]any{branchCommit("dependabot[bot]", "dependabot[bot]"), branchCommit("Someone", "")}, true},
		"more commits than were fetched": {"dependabot", 40, []map[string]any{branchCommit("dependabot[bot]", "dependabot[bot]")}, true},
		"a person's pull request":        {"claude", 2, []map[string]any{branchCommit("Claude", "claude"), branchCommit("Ryan", "alrayyes")}, false},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			result := github.NewClient("test-token", "", editedBranchServer(t, tc.author, tc.total, tc.commits...).URL).Fetch(t.Context())

			require.Len(t, result.PullRequests, 1)
			assert.Equal(t, tc.want, result.PullRequests[0].EditedByOthers)
		})
	}
}
